import type { AgentTool, ToolTier } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { type ApprovalPolicy, getToolDecision, normalizePolicy, type ResolvedApproval } from "../approval";
import { bashApprovalPatternToRegExp, normalizeBashApprovalPattern } from "../bash";
import { CURATED_ALLOW_TOOLS, isSafeConsumerStage, matchCuratedDeny } from "./curated";
import { loadRuleLayers, type PermissionRule, type RuleLayer } from "./rules";
import { extractSubCommands, isPipeline, isSinglePiece, parseCommand, type ShellPiece } from "./split";

export type PermissionPolicy = "allow" | "deny" | "prompt";
export type Posture = "allow" | "prompt" | "deny";

export interface PieceEvaluation {
	text: string;
	policy: PermissionPolicy;
	ruleId?: string;
	layer?: RuleLayer;
	reason?: string;
}

export interface EngineDecision {
	policy: PermissionPolicy;
	tier: ToolTier;
	reason?: string;
	ruleId?: string;
	layer?: RuleLayer;
	source: "tool" | "user" | "curated" | "rule" | "posture";
	/** True only for tool-declared `override: true` / `prompt` decisions (Task 7's explicitPrompt depends on it). */
	override: boolean;
	pieces?: PieceEvaluation[];
}

export interface EngineContext {
	settings: Pick<Settings, "get" | "isConfigured">;
	cwd: string;
	home?: string;
}

type DecisionSource = EngineDecision["source"];
type ApprovalSubjectLike = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

const BASH_TOOL = { name: "bash", approval: undefined, formatApprovalDetails: undefined };

/** `permissions.default` is read through the settings schema (added with the engine; Task 6 extends the group). */
export const POSTURE_KEY = "permissions.default";

let invalidRegexWarned = false;

let legacyPostureWarned = false;

/**
 * Map a legacy `tools.approvalMode` value onto the engine posture
 * (yolo → allow; write and always-ask → prompt). Unmappable values return
 * `undefined` and the caller falls back to the posture default. Single source
 * of truth for the mapping — the migration plan mirrors it when it seeds
 * `permissions.default` from the legacy key.
 */
export function postureFromApprovalMode(mode: unknown): Posture | undefined {
	if (mode === "yolo") return "allow";
	if (mode === "write" || mode === "always-ask") return "prompt";
	return undefined;
}

/**
 * Resolve the default posture (precedence step 11): an explicitly configured
 * `permissions.default` wins; otherwise a legacy `tools.approvalMode` that the
 * user actually configured maps onto a posture; otherwise the deny-by-default
 * `prompt`.
 *
 * The mode mapping only applies when the key is explicitly configured — its
 * schema default (`yolo`) must not bypass the engine's default posture.
 */
export function resolvePosture(settings: Pick<Settings, "get" | "isConfigured">): Posture {
	if (settings.isConfigured(POSTURE_KEY)) {
		const raw = settings.get(POSTURE_KEY);
		return raw === "allow" || raw === "deny" ? raw : "prompt";
	}
	if (settings.isConfigured("tools.approvalMode")) {
		const posture = postureFromApprovalMode(settings.get("tools.approvalMode"));
		if (posture !== undefined) {
			if (!legacyPostureWarned) {
				legacyPostureWarned = true;
				logger.warn(
					"Permission posture resolved from legacy tools.approvalMode, which is hidden from the settings UI. Run /permissions migrate to move it to permissions.default.",
				);
			}
			return posture;
		}
	}
	return "prompt";
}

/** Legacy `bash.patterns` settings entries as a `legacy`-layer rule list (last in layer tie-break order). */
function legacyBashPatterns(settings: Pick<Settings, "get" | "isConfigured">): PermissionRule[] {
	const raw: unknown = settings.get("bash.patterns");
	if (!Array.isArray(raw)) return [];
	const rules: PermissionRule[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		const match =
			typeof record.match === "string" ? legacyBashPattern(normalizeBashApprovalPattern(record.match)) : undefined;
		const approval = typeof record.approval === "string" ? record.approval.trim().toLowerCase() : undefined;
		if (match === undefined || match.length === 0) continue;
		if (approval !== "allow" && approval !== "deny" && approval !== "prompt") continue;
		rules.push({
			id: `legacy-${rules.length}`,
			tool: "bash",
			match: { command: match },
			action: approval,
			layer: "legacy",
		});
	}
	return rules;
}

/** Legacy `tools.approval.<tool>` policy for a tool, if any. */
function legacyUserPolicy(
	settings: Pick<Settings, "get" | "isConfigured">,
	toolName: string,
): PermissionPolicy | undefined {
	const config: unknown = settings.get("tools.approval");
	if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
	return normalizePolicy((config as Record<string, unknown>)[toolName]);
}

function bashCommandArg(args: unknown): string | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as Record<string, unknown>).command;
	return typeof value === "string" ? value : undefined;
}

/** A `/…/`-wrapped string is a regex; anything else matches literally or as a `*` glob. */
function isRegexWrapped(pattern: string): boolean {
	return pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2;
}

/**
 * Preserve pre-engine glob-only semantics for a legacy `bash.patterns` value:
 * the old approval path matched the whole string as a glob with literal
 * slashes, so a `/…/`-wrapped pattern never matched a real command. The
 * engine's match layer would reinterpret the wrapper as an unanchored regex —
 * an over-allow for legacy allow rules — so escape the leading/trailing
 * slashes back to literal glob text, keeping such patterns inert exactly as
 * before. Only fully `/…/`-wrapped patterns are touched: a pattern that
 * merely ends in a slash (`rm -rf /`) was a live glob in the old path and
 * stays one. Modern file-backed rules keep regex interpretation.
 */
export function legacyBashPattern(pattern: string): string {
	if (!(pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2)) return pattern;
	return pattern.replace(/^\//u, "\\/").replace(/\/$/u, "\\/");
}

function compileRegex(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern.slice(1, -1), "u");
	} catch (error) {
		if (!invalidRegexWarned) {
			invalidRegexWarned = true;
			logger.warn("Permission rule contains an invalid regex; the rule will never match", { pattern, error });
		}
		return null;
	}
}

function matchPatternValue(key: string, value: unknown, pattern: unknown): boolean {
	if (typeof pattern !== "string") return value === pattern;
	if (isRegexWrapped(pattern)) {
		const regex = compileRegex(pattern);
		if (regex === null || typeof value !== "string") return false;
		return regex.test(key === "command" ? normalizeBashApprovalPattern(value) : value);
	}
	if (typeof value !== "string") return false;
	if (key === "command" || pattern.includes("*")) {
		// Whitespace-normalized glob matching, identical to the bash approval helpers.
		const candidate = key === "command" ? normalizeBashApprovalPattern(value) : value;
		return bashApprovalPatternToRegExp(pattern).test(candidate);
	}
	return value === pattern;
}

export type MatchClass = "exact-structure" | "covering";

/**
 * Whether a command pattern explicitly contains pipeline structure: a literal
 * `|` in a glob, or an unescaped alternation in a regex-wrapped pattern.
 */
export function patternHasPipe(pattern: string): boolean {
	if (isRegexWrapped(pattern)) {
		const source = pattern.slice(1, -1);
		for (let i = 0; i < source.length; i++) {
			if (source[i] === "|" && (i === 0 || source[i - 1] !== "\\")) return true;
		}
		return false;
	}
	return pattern.includes("|");
}

/**
 * Specificity score (spec §3.1): literal-token count for glob patterns —
 * `command` patterns split on whitespace, path patterns on `/`; regex-wrapped
 * patterns score the length of their literal prefix. Higher = more specific.
 */
export function patternSpecificity(key: string, pattern: string): number {
	if (isRegexWrapped(pattern)) {
		let length = 0;
		for (const ch of pattern.slice(1, -1)) {
			if (/[.*+?^${}()|[\]\\]/u.test(ch)) break;
			length++;
		}
		return length;
	}
	if (key === "command") {
		return pattern.split(/\s+/u).filter(token => token.length > 0 && !token.includes("*") && !token.includes("?"))
			.length;
	}
	return pattern.split("/").filter(segment => segment.length > 0 && !segment.includes("*") && !segment.includes("?"))
		.length;
}

/** Match class of a pattern against a command (spec §3.1): same pipeline shape = exact-structure, else covering. */
export function matchClassOf(pattern: string, command: string | undefined): MatchClass {
	if (command === undefined || command.length === 0) return "exact-structure";
	return patternHasPipe(pattern) === isPipeline(command) ? "exact-structure" : "covering";
}

export interface RuleMatch {
	rule: PermissionRule;
	matchClass: MatchClass;
	specificity: number;
}

const LAYER_RANK: Record<RuleLayer, number> = { dynamic: 0, project: 1, user: 2, legacy: 3, curated: 4 };

/**
 * Best whole-command rule match (spec §3.1 step 2): match class, then
 * specificity, then deny-wins-ties, then layer order. Returns undefined when
 * nothing matches. The caller owns shell-control degradation of allow winners.
 */
export function resolveWholeCommandRule(
	rules: PermissionRule[],
	toolName: string,
	args: unknown,
): RuleMatch | undefined {
	const command = toolName === "bash" ? bashCommandArg(args) : undefined;
	let best: RuleMatch | undefined;
	for (const rule of rules) {
		if (!matchRule(rule, toolName, args)) continue;
		const commandPattern = rule.match.command;
		const matchClass: MatchClass =
			typeof commandPattern === "string" ? matchClassOf(commandPattern, command) : "exact-structure";
		const specKey = typeof commandPattern === "string" ? "command" : (Object.keys(rule.match)[0] ?? "");
		const specificity =
			typeof commandPattern === "string"
				? patternSpecificity("command", commandPattern)
				: patternSpecificity(specKey, String(rule.match[specKey] ?? ""));
		const candidate: RuleMatch = { rule, matchClass, specificity };
		if (best === undefined) {
			best = candidate;
			continue;
		}
		const classRank = (match: RuleMatch): number => (match.matchClass === "exact-structure" ? 1 : 0);
		const layerRank = (r: PermissionRule): number => LAYER_RANK[r.layer] ?? 9;
		const better =
			classRank(candidate) !== classRank(best)
				? classRank(candidate) > classRank(best)
				: candidate.specificity !== best.specificity
					? candidate.specificity > best.specificity
					: candidate.rule.action === best.rule.action
						? layerRank(candidate.rule) < layerRank(best.rule)
						: candidate.rule.action === "deny" || best.rule.action === "deny"
							? candidate.rule.action === "deny" // deny wins ties
							: layerRank(candidate.rule) < layerRank(best.rule); // layer wins non-deny ties
		if (better) best = candidate;
	}
	return best;
}

/**
 * Unquoted constructs that make a piece unanalyzable in place: separators that
 * survive into a piece, and redirects. Pipelines, `$(…)`/backticks, and parens
 * are NOT here — their sub-commands are evaluated through the rule pipeline
 * (`extractSubCommands` + recursion) instead of degrading.
 */
const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"<": true,
	">": true,
};
/**
 * The full original control set, used for content inside quotes: a `-c`/`-e`
 * option reinterprets that content as code, so ANY control there (including
 * analyzable constructs) marks the argument suspicious.
 */
const BASH_APPROVAL_ALL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};
/**
 * Interpreter escape hatches whose argument is code by definition, regardless
 * of content: PowerShell `-Command` and cmd.exe `/c` `/k`. Unconditional so a
 * rule allow never vouches for them; benign `-c` flag usages (`curl -c`,
 * `grep -c`, `git -c`) stay content-gated below.
 */
const BASH_APPROVAL_COMMAND_FLAG_RE = /(?:^|[ \t])(?:-[Cc]ommand|\/[ck])(?:[= \t]|$|['"])/u;
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$|['"])/u;
/**
 * Concatenated option forms (`python3 -c'…'`, `perl -e'…'`, `git -c'x=y'`,
 * `-ccode`) reinterpret the attached argument as code even when its quoted
 * content carries no shell control chars, so they trip the guard on their own.
 * The option class is narrowed to non-whitespace and the tail has no `$`
 * alternative so benign flag forms stay allowable: `curl -c cookies.txt`
 * (space-separated cookie-jar arg) and a bare trailing `grep -c` must not
 * match. Broad beyond that on purpose — false positives over-prompt (safe).
 */
const BASH_APPROVAL_CONCATENATED_OPTION_RE = /(?:^|[ \t])(?:-[^- \t]*[ce]|--(?:command|eval))(?:['"]|[^\s'"])/u;

/**
 * Restored from the pre-engine bash approval fn (plan ruling R1): an `allow`
 * rule must never vouch for a command that can smuggle a second command
 * through shell syntax the rule pipeline cannot analyze — redirects and
 * `-c`/`-e`/`-Command`/`/c` reinterpreting options — even when the whole line
 * parses as one piece. Pipelines, `$(…)`, and backticks are NOT guarded here:
 * their sub-commands are evaluated through the rule pipeline itself
 * (`extractSubCommands` + recursive `evaluateBashCommand`), so a rule allow
 * only stands when every sub-command passes. Conservative text-based scan on
 * the piece text; false positives over-prompt (safe).
 */
export function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_ALL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_ALL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			// Any control there (including analyzable substitutions) can be
			// re-executed if a `-c`/`-e` option reinterprets the argument, so it
			// marks the reinterpretable flag; substitutions themselves are
			// analyzed by the recursion rather than degrading in place.
			if (Object.hasOwn(BASH_APPROVAL_ALL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code;
	// concatenated forms (`-c'…'`, `-e'…'`) count on their own. PowerShell
	// `-Command` and cmd.exe `/c` `/k` are code-by-definition and unconditional.
	return (
		(hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command)) ||
		BASH_APPROVAL_CONCATENATED_OPTION_RE.test(command) ||
		BASH_APPROVAL_COMMAND_FLAG_RE.test(command)
	);
}

/**
 * An allow rule matching a bash command must not auto-approve when the command
 * carries shell control (ruling R1): return `true` when the rule should
 * degrade to a prompt instead.
 */
function bashAllowDegradedByShellControl(toolName: string, command: string | undefined): boolean {
	return toolName === "bash" && command !== undefined && hasBashApprovalShellControl(command);
}

/**
 * Rule matching per the Global Constraints: the tool must match (or the rule is
 * `*`), every `match` entry must hold (AND), and a single-entry match whose
 * value is exactly `*` always matches (Task 9's per-tool legacy policy rules).
 */
export function matchRule(rule: PermissionRule, toolName: string, args: unknown): boolean {
	if (rule.tool !== "*" && rule.tool !== toolName) return false;
	const entries = Object.entries(rule.match);
	if (entries.length === 1 && entries[0][1] === "*") return true;
	if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
	const record = args as Record<string, unknown>;
	for (const [key, pattern] of entries) {
		if (!Object.hasOwn(record, key)) return false;
		if (!matchPatternValue(key, record[key], pattern)) return false;
	}
	return true;
}

/**
 * Full decision pipeline (Global Constraints precedence steps 1–8):
 *
 * 1. tool-declared deny
 * 2. legacy user-policy deny (`tools.approval.<tool>: deny`)
 * 3. curated deny (`CRITICAL_BASH_PATTERNS` for bash) — absolute, checked
 *    before the rule pool so critical patterns always surface their own source
 * 4. unified whole-command resolution over the legacy `bash.patterns` pool
 *    joined with the file-backed rules (match class → specificity →
 *    deny-wins-ties → layer order; legacy allows gated on a single-piece
 *    command, spec §3.1/§3.3)
 * 5. tool-declared `prompt` / `override: true`
 * 6. legacy user-policy prompt
 * 7. legacy user-policy allow
 * 8. curated read-only allowlist, then default posture
 */
function evaluatePermissionCore(
	tool: { name: string; approval?: unknown; formatApprovalDetails?: unknown },
	args: unknown,
	ctx: EngineContext,
	legacyAllowEnabled: boolean,
	decision: Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy },
): EngineDecision {
	if (decision.policy === "deny") {
		return {
			policy: "deny",
			tier: decision.tier,
			reason: decision.reason,
			source: "tool",
			override: decision.override,
		};
	}

	const userPolicy = legacyUserPolicy(ctx.settings, tool.name);
	if (userPolicy === "deny") {
		return { policy: "deny", tier: decision.tier, source: "user", override: false };
	}

	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	const command = bashCommandArg(args);

	const curated = matchCuratedDeny(tool.name, command);
	if (curated) {
		return {
			policy: "deny",
			tier: decision.tier,
			layer: "curated",
			reason: `matches curated critical pattern /${curated.pattern.source}/`,
			source: "curated",
			override: false,
		};
	}

	// Unified whole-command resolution (spec §3.1 step 2): the legacy
	// `bash.patterns` pool joins the file-backed rules, with its allow gate
	// (single-piece command) preserved. Deny no longer short-circuits by list
	// order — match class, specificity, deny-wins-ties, then layer order
	// decide. `allow` degrades to a prompt when the command carries shell
	// control (ruling R1); `prompt` rules match any piece text (ruling R2).
	const legacy = legacyBashPatterns(ctx.settings);
	const legacyAllowActive = legacyAllowEnabled && command !== undefined && isSinglePiece(command);
	const pool = [...legacy.filter(rule => rule.action !== "allow" || legacyAllowActive), ...rules];
	const best = resolveWholeCommandRule(pool, tool.name, args);
	if (best !== undefined) {
		const degraded = best.rule.action === "allow" && bashAllowDegradedByShellControl(tool.name, command);
		return {
			policy: degraded ? "prompt" : best.rule.action,
			tier: decision.tier,
			ruleId: best.rule.id,
			layer: best.rule.layer,
			reason: best.rule.reason,
			source: "rule",
			override: false,
		};
	}

	if (decision.policy === "prompt" || decision.override) {
		return { policy: "prompt", tier: decision.tier, reason: decision.reason, source: "tool", override: true };
	}

	if (userPolicy === "prompt") {
		return { policy: "prompt", tier: decision.tier, source: "user", override: false };
	}

	if (userPolicy === "allow") {
		return { policy: "allow", tier: decision.tier, source: "user", override: false };
	}

	if ((CURATED_ALLOW_TOOLS as readonly string[]).includes(tool.name)) {
		return { policy: "allow", tier: decision.tier, source: "curated", override: false };
	}

	return { policy: resolvePosture(ctx.settings), tier: decision.tier, source: "posture", override: false };
}

export function evaluatePermission(
	tool: { name: string; approval?: unknown; formatApprovalDetails?: unknown },
	args: unknown,
	ctx: EngineContext,
): EngineDecision {
	return evaluatePermissionInner(tool, args, ctx, true);
}

/**
 * Evaluate the full pipeline, carrying the tool approval's own engine analysis
 * onto the walk result. Tool approvals that run the engine themselves (the
 * bash tool's per-piece {@link evaluateBashCommand}) attach the full decision
 * to their approval return; the walk's own tool-denied short-circuit would
 * otherwise discard the piece attribution computed there. Walk-computed
 * attribution always wins; the attached analysis only fills fields the walk
 * did not produce (ruleId/layer of the decisive piece for tool-denied
 * compounds) plus the per-piece breakdown (spec §7 audit data).
 */
function evaluatePermissionInner(
	tool: { name: string; approval?: unknown; formatApprovalDetails?: unknown },
	args: unknown,
	ctx: EngineContext,
	legacyAllowEnabled: boolean,
): EngineDecision {
	const decision = getToolDecision(tool as ApprovalSubjectLike, args);
	const result = evaluatePermissionCore(tool, args, ctx, legacyAllowEnabled, decision);
	const attached = decision.engineDecision;
	if (attached === undefined) return result;
	return {
		...result,
		ruleId: result.ruleId ?? attached.ruleId,
		layer: result.layer ?? attached.layer,
		pieces: attached.pieces,
	};
}

interface BashPieceResult {
	evaluation: PieceEvaluation;
	source: DecisionSource;
}

function denyReason(piece: PieceEvaluation): string {
	const base = `Denied: piece "${piece.text}"`;
	const detail =
		piece.reason ??
		(piece.ruleId
			? `rule ${piece.ruleId} (${piece.layer ?? "rule"})`
			: piece.layer
				? `${piece.layer} deny policy`
				: "denied by policy");
	return `${base} — ${detail}`;
}

function evaluateBashPiece(
	piece: ShellPiece,
	ctx: EngineContext,
	legacyAllowEnabled: boolean,
	depth: number,
): BashPieceResult {
	const decision = evaluatePermissionInner(BASH_TOOL, { command: piece.text }, ctx, legacyAllowEnabled);
	if (decision.policy !== "allow") {
		return {
			evaluation: {
				text: piece.text,
				policy: decision.policy,
				ruleId: decision.ruleId,
				layer: decision.layer,
				reason: decision.reason,
			},
			source: decision.source,
		};
	}

	// A rule-based allow must not vouch for a command that smuggles executable
	// content through analyzable shell constructs (pipelines, `$(…)`/backtick
	// substitutions): each sub-command is evaluated through the same pipeline,
	// and the piece allow only stands when every sub-command is allowed.
	// Unanalyzable residue (malformed constructs, non-simple pipeline stages,
	// excessive nesting) degrades the allow to a prompt (R1 — over-prompt).
	const subs = extractSubCommands(piece.text, depth);
	if (subs === null) {
		return {
			evaluation: {
				text: piece.text,
				policy: "prompt",
				ruleId: decision.ruleId,
				layer: decision.layer,
				reason: decision.reason,
			},
			source: "rule",
		};
	}
	let sawPrompt: BashPieceResult | undefined;
	for (const sub of subs) {
		const subDecision = evaluateBashCommand(sub, ctx, depth + 1);
		if (subDecision.policy === "deny") {
			return {
				evaluation: {
					text: piece.text,
					policy: "deny",
					ruleId: subDecision.ruleId ?? decision.ruleId,
					layer: subDecision.layer ?? decision.layer,
					reason: subDecision.reason,
				},
				source: subDecision.source,
			};
		}
		if (subDecision.policy === "prompt" && subDecision.source === "posture" && isSafeConsumerStage(sub)) {
			// §4.3 safe-consumer exemption: no rule touched this stage, and it is a
			// curated pure filter — treat it as allowed.
			continue;
		}
		if (subDecision.policy === "prompt" && sawPrompt === undefined) {
			sawPrompt = {
				evaluation: {
					text: piece.text,
					policy: "prompt",
					ruleId: subDecision.ruleId,
					layer: subDecision.layer,
					reason: subDecision.reason,
				},
				source: subDecision.source,
			};
		}
	}
	if (sawPrompt !== undefined) return sawPrompt;
	return {
		evaluation: {
			text: piece.text,
			policy: "allow",
			ruleId: decision.ruleId,
			layer: decision.layer,
			reason: decision.reason,
		},
		source: decision.source,
	};
}

/**
 * Split a bash command, evaluate each piece through the same pipeline, and
 * compose: any deny denies the whole call (the reason names the piece); pending
 * pieces are listed for the dialog; otherwise the call is allowed.
 *
 * A parse failure collapses the whole command into one piece (fail-closed).
 * Legacy `bash.patterns` allow rules only apply when the whole command is a
 * single piece; deny/prompt patterns match any piece text.
 */
export function evaluateBashCommand(command: string, ctx: EngineContext, depth = 0): EngineDecision {
	const out = parseCommand(command);
	const pieces: ShellPiece[] =
		out.ok && out.pieces.length > 0 ? out.pieces : [{ text: command.trim(), operator: null }];
	const legacyAllowEnabled = isSinglePiece(command);
	const results = pieces.map(piece => evaluateBashPiece(piece, ctx, legacyAllowEnabled, depth));
	const evaluations = results.map(result => result.evaluation);

	const denied = results.find(result => result.evaluation.policy === "deny");
	if (denied) {
		const piece = denied.evaluation;
		return {
			policy: "deny",
			tier: "exec",
			reason: denyReason(piece),
			ruleId: piece.ruleId,
			layer: piece.layer,
			source: denied.source,
			override: false,
			pieces: evaluations,
		};
	}

	// Ruling R3: the piece tokenizer normalizes some critical shapes (fork
	// bombs, process substitution) past the per-piece curated patterns, so also
	// match the curated deny set against the RAW command. Runs after the
	// per-piece deny so legacy/file rule attribution is preserved, and before
	// pending/allow so a normalized critical shape denies instead of prompting.
	const rawCurated = matchCuratedDeny("bash", command);
	if (rawCurated) {
		const piece: PieceEvaluation = {
			text: command.trim(),
			policy: "deny",
			layer: "curated",
			reason: `matches curated critical pattern /${rawCurated.pattern.source}/`,
		};
		return {
			policy: "deny",
			tier: "exec",
			reason: denyReason(piece),
			layer: "curated",
			source: "curated",
			override: false,
			pieces: evaluations,
		};
	}

	const pending = results.filter(result => result.evaluation.policy === "prompt");
	if (pending.length > 0) {
		const decisive = pending.find(result => result.source !== "posture") ?? pending[0];
		return {
			policy: "prompt",
			tier: "exec",
			ruleId: decisive.evaluation.ruleId,
			layer: decisive.evaluation.layer,
			source: decisive.source,
			override: false,
			pieces: evaluations,
		};
	}

	const decisive = results.find(result => result.source !== "posture") ?? results[0];
	return {
		policy: "allow",
		tier: "exec",
		ruleId: decisive.evaluation.ruleId,
		layer: decisive.evaluation.layer,
		reason: decisive.evaluation.reason,
		source: decisive.source,
		override: false,
		pieces: evaluations,
	};
}
