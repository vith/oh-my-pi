import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolTier } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { isPosixShell } from "@oh-my-pi/pi-utils/procmgr";
import type { EngineSettings } from "./settings";
import { type ApprovalPolicy, getToolDecision, normalizePolicy, type ResolvedApproval } from "../approval";
import { bashApprovalPatternToRegExp, normalizeBashApprovalPattern } from "../bash";
import { CRITICAL_BASH_PATTERNS } from "./critical-patterns";
import { extractLiteralAndChainSegments, type LiteralShellCommandSegment } from "../shell-tokenize";
import { CURATED_ALLOW_TOOLS, isSafeConsumerStage, matchCuratedDeny } from "./curated";
import { findNearestProjectRoot, loadRuleLayers, type PermissionRule, type RuleLayer } from "./rules";
import { sessionRuleKey, sessionRules } from "./session-rules";
import {
	extractSubCommands,
	isPipeline,
	isSinglePiece,
	parseCommand,
	type ShellPiece,
	scanRedirectWrites,
	stripFileWriteRedirects,
} from "./split";

export type PermissionPolicy = "allow" | "deny" | "prompt";
export type Posture = "allow" | "prompt" | "deny";

export interface PieceEvaluation {
	text: string;
	policy: PermissionPolicy;
	ruleId?: string;
	layer?: RuleLayer;
	reason?: string;
	/** Top-level control operator that preceded this piece (bash compounds only). */
	operator?: ShellPiece["operator"];
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
	settings: EngineSettings;
	cwd: string;
	home?: string;
	/**
	 * Session-manager id, resolving the in-memory session rule layer
	 * ("Allow for this session"). Absent in headless flows — the store falls
	 * back to the cwd.
	 */
	sessionId?: string;
	/**
	 * Resolved shell executable for `bash.allowCompoundCommands` gating
	 * (upstream compound approval). Absent callers keep the legacy per-piece
	 * evaluation regardless of the setting.
	 */
	shell?: string;
}

type DecisionSource = EngineDecision["source"];
type ApprovalSubjectLike = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

const BASH_TOOL = { name: "bash", approval: undefined, formatApprovalDetails: undefined };

/** `permissions.default` is read through the settings schema (added with the engine; Task 6 extends the group). */
export const POSTURE_KEY = "permissions.default";

/**
 * Write tools whose target path can be attributed and contained: `edit` and
 * `write` carry a single `path`, `ast_edit` a `paths` array. Bash redirects
 * and MCP tools are intentionally excluded — their writes cannot be attributed
 * to a project path.
 */
const PROJECT_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_edit"]);

/** `permissions.projectWrites` is read through the settings schema. */
export const PROJECT_WRITES_KEY = "permissions.projectWrites";

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
export function resolvePosture(settings: EngineSettings): Posture {
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

/**
 * Resolve the project-writes posture: an explicitly configured
 * `permissions.projectWrites` wins; otherwise the general posture applies.
 * The schema default (`prompt`) is inert until configured, mirroring
 * {@link resolvePosture}.
 */
export function resolveProjectWritesPosture(settings: EngineSettings): Posture {
	if (settings.isConfigured(PROJECT_WRITES_KEY)) {
		const raw = settings.get(PROJECT_WRITES_KEY);
		return raw === "allow" || raw === "deny" ? raw : "prompt";
	}
	return resolvePosture(settings);
}

/**
 * The target path of a write tool call, resolved against cwd (and `~` when
 * home is known). `edit`/`write` carry `path`; `ast_edit` carries `paths`.
 */
function writeTargetPath(args: unknown, cwd: string, home: string | undefined): string | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	let target: string | undefined;
	if (typeof record.path === "string" && record.path.length > 0) {
		target = record.path;
	} else if (Array.isArray(record.paths)) {
		target = record.paths.find((value): value is string => typeof value === "string" && value.length > 0);
	}
	if (target === undefined) return undefined;
	if (target === "~" || target.startsWith("~/")) {
		const homeDir = home ?? "";
		if (homeDir.length > 0) return path.join(homeDir, target.slice(target === "~" ? 1 : 2));
	}
	return path.resolve(cwd, target);
}

/** True when the (possibly relative) target path resolves inside the nearest project root. */
function isInsideProjectDir(target: string, cwd: string): boolean {
	const root = findNearestProjectRoot(cwd);
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The posture that applies to this call: write tools targeting the project
 * directory use `permissions.projectWrites` when configured, everything else
 * uses the general posture.
 */
function resolveEffectivePosture(ctx: EngineContext, toolName: string, args: unknown): Posture {
	if (PROJECT_WRITE_TOOLS.has(toolName)) {
		const target = writeTargetPath(args, ctx.cwd, ctx.home);
		if (target !== undefined && isInsideProjectDir(target, ctx.cwd)) {
			return resolveProjectWritesPosture(ctx.settings);
		}
	}
	return resolvePosture(ctx.settings);
}

/** Legacy `bash.patterns` settings entries as a `legacy`-layer rule list (last in layer tie-break order). */
export function legacyBashPatterns(settings: EngineSettings): PermissionRule[] {
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
function legacyUserPolicy(settings: EngineSettings, toolName: string): PermissionPolicy | undefined {
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

/**
 * Normalize a bash command text for rule matching: collapse whitespace runs
 * (as {@link normalizeBashApprovalPattern}) AND drop whitespace immediately
 * after `|`, mirroring the tokenizer's glued stage text ("… |head -1").
 * Applying it to an already-normalized pattern is a no-op (idempotent), so
 * both spec-canonical spaced patterns and dialog-exact candidates compare
 * against the same normalized form.
 */
function normalizeBashMatchText(value: string): string {
	return normalizeBashApprovalPattern(value).replace(/\|\s+/gu, "|");
}

/**
 * Expand a leading `~` (the user's home) in a path pattern or path value.
 * Command keys never expand: `cd ~/x` is literal text on both sides, and
 * expanding only one side would break the match.
 */
function expandPathHome(text: string): string {
	if (text === "~") return os.homedir();
	if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
	return text;
}

export function matchPatternValue(key: string, value: unknown, pattern: unknown): boolean {
	if (typeof pattern !== "string") return value === pattern;
	if (isRegexWrapped(pattern)) {
		const regex = compileRegex(pattern);
		if (regex === null || typeof value !== "string") return false;
		return regex.test(key === "command" ? normalizeBashApprovalPattern(value) : value);
	}
	if (typeof value !== "string") return false;
	// Path keys (`path`, `file`, …) treat a leading `~` as the user's home on
	// both sides, so `~/.omp/**` rules match absolute call paths.
	const candidate = key === "command" ? value : expandPathHome(value);
	const expandedPattern = key === "command" ? pattern : expandPathHome(pattern);
	if (key === "command" || expandedPattern.includes("*")) {
		// Whitespace-normalized glob matching, identical to the bash approval
		// helpers — with both sides pipe-normalized so spaced and glued pipe
		// forms are interchangeable.
		const normalizedCandidate = key === "command" ? normalizeBashMatchText(candidate) : candidate;
		const normalizedPattern = key === "command" ? normalizeBashMatchText(expandedPattern) : expandedPattern;
		return bashApprovalPatternToRegExp(normalizedPattern).test(normalizedCandidate);
	}
	return candidate === expandedPattern;
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

const LAYER_RANK: Record<RuleLayer, number> = { project: 0, user: 1, legacy: 2, session: 3, curated: 4 };

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
		// Specificity sums the literal count of EVERY match key (spec §3.1): a
		// rule matching on command + arg is strictly more specific than the
		// same command pattern alone.
		let specificity = 0;
		for (const [key, pattern] of Object.entries(rule.match)) {
			if (typeof pattern === "string") specificity += patternSpecificity(key, pattern);
		}
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

/** Resolve a redirect target to an absolute path (home- and cwd-relative). */
function resolveRedirectTarget(target: string, ctx: EngineContext): string {
	const home = ctx.home ?? os.homedir();
	const expanded = target === "~" ? home : target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ctx.cwd, expanded);
}

/**
 * The posture that sanctions a redirect write target, mirroring the write
 * tools' {@link resolveEffectivePosture}: project-internal targets use
 * `permissions.projectWrites`, everything else the general posture.
 * `/dev/null` is a discard device, not a real write, and is always allowed.
 */
function redirectWritePosture(ctx: EngineContext, target: string): Posture {
	if (target === "/dev/null") return "allow";
	if (isInsideProjectDir(resolveRedirectTarget(target, ctx), ctx.cwd)) {
		return resolveProjectWritesPosture(ctx.settings);
	}
	return resolvePosture(ctx.settings);
}

/**
 * Aggregate the redirect write postures for a command (targets from the Rust
 * brush parser, not a text scan): any denied target denies; an unattributable
 * or unsanctioned write prompts; otherwise (every target sanctioned —
 * including the empty set of pure fd duplication) the redirects are allowed.
 * `undefined` when the command carries no file-writing redirect or does not
 * parse (fail-closed — the caller's conservative decision stands).
 */
function redirectWritePostureFor(command: string, ctx: EngineContext): "allow" | "prompt" | "deny" | undefined {
	const scan = scanRedirectWrites(command);
	if (scan === null || !scan.present) return undefined;
	if (scan.unattributable) return "prompt";
	let sawPrompt = false;
	for (const target of scan.targets) {
		const posture = redirectWritePosture(ctx, target);
		if (posture === "deny") return "deny";
		if (posture !== "allow") sawPrompt = true;
	}
	return sawPrompt ? "prompt" : "allow";
}

/** Name the first denied redirect target in a reason string. */
function redirectDenyReason(command: string, ctx: EngineContext): string {
	const scan = scanRedirectWrites(command);
	for (const target of scan?.targets ?? []) {
		if (redirectWritePosture(ctx, target) === "deny") {
			return `redirect write to "${target}" denied by policy`;
		}
	}
	return "redirect write denied by policy";
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
 * 8. curated read-only allowlist, then the redirect write gate (bash
 *    `>`-redirection targets must be sanctioned by posture — projectWrites
 *    inside the project, the general posture elsewhere; a denied target
 *    denies, an unsanctioned one prompts), then default posture
 */
function evaluatePermissionCore(
	tool: { name: string; approval?: unknown; formatApprovalDetails?: unknown },
	args: unknown,
	ctx: EngineContext,
	legacyAllowEnabled: boolean,
	decision: Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy },
	skipCuratedDeny = false,
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

	// Compound `&&` chains under `bash.allowCompoundCommands` skip the curated
	// deny here: pattern-allowed critical segments surface as a critical
	// prompt later (upstream parity) instead of denying. Sub-command
	// recursion re-enters with the default, so curated denies still fire
	// inside substitutions.
	const curated = skipCuratedDeny ? null : matchCuratedDeny(tool.name, command);
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
	// Allow rules only ever vouch for a single-piece command. On a compound,
	// the whole-command match would always degrade (its `&&`/`;` separators
	// are shell control, R1) and force a prompt even when every piece is
	// posture- or rule-allowed — the bash tool's per-piece evaluation is the
	// granular authority there, and it skips the degradation for posture
	// allows. Deny/prompt rules keep matching the joined string.
	const multiPieceBash = command !== undefined && !isSinglePiece(command);
	const pool = [
		...legacy.filter(rule => rule.action !== "allow" || legacyAllowActive),
		...rules.filter(rule => rule.action !== "allow" || !multiPieceBash),
		...sessionRules(sessionRuleKey(ctx)).filter(rule => rule.action !== "allow" || !multiPieceBash),
	];
	const best = resolveWholeCommandRule(pool, tool.name, args);
	if (best !== undefined) {
		const degraded = best.rule.action === "allow" && bashAllowDegradedByShellControl(tool.name, command);
		if (degraded && command !== undefined) {
			// R1 refinement: a command whose only shell control is redirection
			// is not unanalyzable — the redirects are writes to their targets.
			// When the stripped base command is still rule-covered and every
			// redirect target's write is sanctioned by posture, the allow
			// stands; a denied target denies the call. Any other shell control
			// (`-c`/`-e`/`$(…)`, …) keeps the degradation.
			const base = stripFileWriteRedirects(command);
			if (base !== command && !bashAllowDegradedByShellControl(tool.name, base)) {
				const writePosture = redirectWritePostureFor(command, ctx);
				if (writePosture === "deny") {
					return {
						policy: "deny",
						tier: decision.tier,
						reason: redirectDenyReason(command, ctx),
						source: "posture",
						override: false,
					};
				}
				if (writePosture === "allow" || writePosture === undefined) {
					const baseBest = resolveWholeCommandRule(pool, tool.name, { command: base });
					if (baseBest !== undefined && baseBest.rule.action === "allow") {
						return {
							policy: "allow",
							tier: decision.tier,
							ruleId: baseBest.rule.id,
							layer: baseBest.rule.layer,
							reason: baseBest.rule.reason,
							source: "rule",
							override: false,
						};
					}
				}
			}
		}
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

	// The bash tool runs its own engine evaluation per piece and declares
	// policy "allow" only when every piece is allowed (rules, posture, or
	// safe-consumer). Honor it for compounds: a multi-piece call whose pieces
	// are all rule-covered must not fall through to a posture prompt in
	// prompt mode. Deny/prompt rules and the tool's own prompt/override above
	// still win; only bash declares allow today, so this cannot widen any
	// other tool's approval under prompt posture.
	if (decision.policy === "allow" && multiPieceBash) {
		return { policy: "allow", tier: decision.tier, source: "tool", override: false };
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

	// Redirect write gate (R1 refinement): a bash redirect is a write to its
	// target file, and rules cannot analyze where a redirect points — the
	// write must be sanctioned by posture itself (`permissions.projectWrites`
	// inside the project, the general posture elsewhere, mirroring the write
	// tools). A denied target denies the call even under allow-all; an
	// unsanctioned write prompts. Rule-backed redirect commands were handled
	// in the degraded branch above; this catches everything else.
	if (tool.name === "bash" && command !== undefined) {
		const writePosture = redirectWritePostureFor(command, ctx);
		if (writePosture !== undefined && writePosture !== "allow") {
			return {
				policy: writePosture,
				tier: decision.tier,
				reason:
					writePosture === "deny" ? redirectDenyReason(command, ctx) : "redirect write not sanctioned by posture",
				source: "posture",
				override: false,
			};
		}
	}

	return {
		policy: resolveEffectivePosture(ctx, tool.name, args),
		tier: decision.tier,
		source: "posture",
		override: false,
	};
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
	skipCuratedDeny = false,
): EngineDecision {
	const decision = getToolDecision(tool as ApprovalSubjectLike, args);
	const result = evaluatePermissionCore(tool, args, ctx, legacyAllowEnabled, decision, skipCuratedDeny);
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
	skipCuratedDeny = false,
): BashPieceResult {
	const decision = evaluatePermissionInner(
		BASH_TOOL,
		{ command: piece.text },
		ctx,
		legacyAllowEnabled,
		skipCuratedDeny,
	);
	if (decision.policy !== "allow") {
		return {
			evaluation: {
				text: piece.text,
				operator: piece.operator,
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
	// Posture allows (`permissions.default: allow` / legacy yolo) skip the
	// degradation: the user opted into auto-approving everything not denied
	// and no rule is vouching, so prompting on parser limits under allow-all
	// is noise. Sub-commands are still recursed below, so curated/rule denies
	// inside substitutions keep denying.
	const subs = extractSubCommands(piece.text, depth);
	if (subs === null) {
		if (decision.source === "posture") {
			return {
				evaluation: {
					text: piece.text,
					operator: piece.operator,
					policy: "allow",
					ruleId: decision.ruleId,
					layer: decision.layer,
					reason: decision.reason,
				},
				source: decision.source,
			};
		}
		return {
			evaluation: {
				text: piece.text,
				operator: piece.operator,
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
					operator: piece.operator,
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
					operator: piece.operator,
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
			operator: piece.operator,
			policy: "allow",
			ruleId: decision.ruleId,
			layer: decision.layer,
			reason: decision.reason,
		},
		source: decision.source,
	};
}

/**
 * Upstream `bash.allowCompoundCommands` gate: a literal `&&` chain eligible
 * for per-segment allows. Null unless the setting is enabled, the resolved
 * shell is POSIX, and every segment is literal (no expansion, globbing,
 * redirection, comments, assignments, or stateful builtins) — otherwise the
 * legacy split evaluation below applies. The extractor guarantees two or
 * more segments when non-null.
 */
function compoundSegmentsFor(command: string, ctx: EngineContext): LiteralShellCommandSegment[] | null {
	if (!ctx.settings.get("bash.allowCompoundCommands")) return null;
	if (ctx.shell === undefined || !isPosixShell(ctx.shell)) return null;
	return extractLiteralAndChainSegments(command);
}

/**
 * Whole-or-segment restriction check over raw texts: the anchored glob
 * matches the whole command or any piece text as written. Quoting is never
 * stripped, so a quoted binary (`"rm" -rf /x`) keeps evading an anchored
 * glob exactly as in per-piece evaluation.
 */
function findWholeChainRestriction(
	command: string,
	segments: readonly LiteralShellCommandSegment[],
	ctx: EngineContext,
): PermissionRule | undefined {
	let prompt: PermissionRule | undefined;
	for (const rule of legacyBashPatterns(ctx.settings)) {
		if (rule.action !== "deny" && rule.action !== "prompt") continue;
		const pattern = rule.match.command;
		if (typeof pattern !== "string") continue;
		if (!matchPatternValue("command", command, pattern)) continue;
		if (segments.some(segment => matchPatternValue("command", segment.text, pattern))) continue;
		if (rule.action === "deny") return rule;
		prompt ??= rule;
	}
	return prompt;
}

/**
 * Legacy compound approval for non-literal chains: the first deny/prompt
 * `bash.patterns` rule matching the whole command or any raw piece text.
 * Allow rules never ride a compound (shell control), so they are skipped.
 */
function findCompoundRestriction(
	command: string,
	pieceTexts: readonly string[],
	ctx: EngineContext,
): PermissionRule | undefined {
	for (const rule of legacyBashPatterns(ctx.settings)) {
		if (rule.action !== "deny" && rule.action !== "prompt") continue;
		const pattern = rule.match.command;
		if (typeof pattern !== "string") continue;
		if (matchPatternValue("command", command, pattern)) return rule;
		if (pieceTexts.some(text => matchPatternValue("command", text, pattern))) return rule;
	}
	return undefined;
}

function denyDecision(
	evaluations: PieceEvaluation[],
	overrides: {
		reason: string;
		ruleId?: string;
		layer?: RuleLayer;
		source: DecisionSource;
	},
): EngineDecision {
	return {
		policy: "deny",
		tier: "exec",
		reason: overrides.reason,
		ruleId: overrides.ruleId,
		layer: overrides.layer,
		source: overrides.source,
		override: false,
		pieces: evaluations,
	};
}

/**
 * Upstream per-segment evaluation for a literal `&&` chain: allows vouch per
 * segment (curated denies yield to the critical prompt below so a
 * pattern-allowed critical segment prompts instead of denying), whole-chain
 * restrictions veto, and critical shapes prompt with override instead of
 * allowing. Unmatched segments fall through to posture so the wrapper keeps
 * the standalone tool-policy and mode fallback.
 */
function evaluateCompoundCommand(
	command: string,
	segments: LiteralShellCommandSegment[],
	ctx: EngineContext,
	depth: number,
): EngineDecision {
	const veto = findWholeChainRestriction(command, segments, ctx);
	const pieces: ShellPiece[] = segments.map((segment, index) => ({
		text: segment.text,
		operator: index < segments.length - 1 ? "&&" : null,
	}));
	const results: BashPieceResult[] = [];
	for (const piece of pieces) {
		const result = evaluateBashPiece(piece, ctx, /*legacyAllowEnabled*/ true, depth, /*skipCuratedDeny*/ true);
		results.push(result);
		if (result.evaluation.policy === "deny") {
			const denied = result.evaluation;
			return denyDecision(
				results.map(item => item.evaluation),
				{
					reason: denyReason(denied),
					ruleId: denied.ruleId,
					layer: denied.layer,
					source: result.source,
				},
			);
		}
	}
	const evaluations = results.map(result => result.evaluation);
	const pending = results.filter(result => result.evaluation.policy === "prompt");
	if (veto?.action === "deny") {
		return denyDecision(evaluations, {
			reason: `Blocked by bash pattern: ${veto.match.command}`,
			ruleId: veto.id,
			layer: veto.layer,
			source: "rule",
		});
	}
	const rulePrompt = pending.find(result => result.source !== "posture");
	if (veto?.action === "prompt" || rulePrompt !== undefined) {
		if (veto?.action === "prompt") {
			return {
				policy: "prompt",
				tier: "exec",
				reason: `Prompt required by bash pattern: ${veto.match.command}`,
				ruleId: veto.id,
				layer: veto.layer,
				source: "rule",
				override: false,
				pieces: evaluations,
			};
		}
		const decisive = rulePrompt as BashPieceResult;
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
	const critical =
		command !== "" &&
		(CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command)) ||
			segments.some(segment => CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(segment.argv.join(" ")))));
	if (critical) {
		return {
			policy: "prompt",
			tier: "exec",
			reason: "Critical pattern detected",
			layer: "curated",
			source: "curated",
			override: true,
			pieces: evaluations,
		};
	}
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

	const decisive = results.find(result => result.source !== "posture") ?? results[results.length - 1];
	return {
		policy: "allow",
		tier: "exec",
		ruleId: decisive?.evaluation.ruleId,
		layer: decisive?.evaluation.layer,
		reason: decisive?.evaluation.reason,
		source: decisive?.source ?? "posture",
		override: false,
		pieces: evaluations,
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
 *
 * With `bash.allowCompoundCommands` on a POSIX shell, a literal `&&` chain
 * takes the per-segment path above; other multi-piece commands surface a
 * whole-or-segment restriction explicitly (singles keep the bare posture
 * fallback so the gate applies the mode).
 */
export function evaluateBashCommand(command: string, ctx: EngineContext, depth = 0): EngineDecision {
	const compound = compoundSegmentsFor(command, ctx);
	if (compound !== null) return evaluateCompoundCommand(command, compound, ctx, depth);

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

	if (pieces.length > 1) {
		const restriction = findCompoundRestriction(
			command,
			pieces.map(piece => piece.text),
			ctx,
		);
		if (restriction?.action === "deny") {
			return denyDecision(evaluations, {
				reason: `Blocked by bash pattern: ${restriction.match.command}`,
				ruleId: restriction.id,
				layer: restriction.layer,
				source: "rule",
			});
		}
		if (restriction?.action === "prompt") {
			return {
				policy: "prompt",
				tier: "exec",
				reason: `Prompt required by bash pattern: ${restriction.match.command}`,
				ruleId: restriction.id,
				layer: restriction.layer,
				source: "rule",
				override: false,
				pieces: evaluations,
			};
		}
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

/**
 * Near-miss line (spec §5.1): the closest rule that shares the piece's first
 * token with a narrower glob but does not match it. Undefined when nothing is
 * genuinely close (different command families are never shown).
 */
export function nearMissLine(pieceText: string, ctx: EngineContext): string | undefined {
	const firstToken = pieceText.trim().split(/\s+/u)[0] ?? "";
	if (firstToken.length === 0) return undefined;
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	let best: PermissionRule | undefined;
	let bestSpecificity = 0;
	for (const rule of [...rules, ...sessionRules(sessionRuleKey(ctx))]) {
		if (rule.tool !== "bash" && rule.tool !== "*") continue;
		const pattern = rule.match.command;
		if (typeof pattern !== "string" || isRegexWrapped(pattern)) continue;
		const patternToken = pattern.split(/\s+/u)[0] ?? "";
		if (patternToken !== firstToken) continue;
		if (matchRule(rule, "bash", { command: pieceText })) continue; // matches — not a miss
		const specificity = patternSpecificity("command", pattern);
		if (specificity > bestSpecificity) {
			bestSpecificity = specificity;
			best = rule;
		}
	}
	if (best === undefined || best.match.command === undefined) return undefined;
	return `≈ ${best.id}: ${String(best.match.command)} (too narrow for this command)`;
}

export interface DenyOverride {
	rule: PermissionRule;
	matchClass: MatchClass;
	specificity: number;
}

/**
 * Deny-error suggestion outcome (spec §5.2): whether a deny rule decided, and
 * the best allow that would strictly beat it.
 * - `no-deny`: no deny rule matched — a posture-source deny. A dynamic allow
 *   beats the posture, so callers suggest the mechanical first candidate.
 * - `dead-end`: a deny decided and no allow strictly beats it (deny wins ties
 *   at equal class/specificity).
 * - `override`: the best strictly-beating allow, with the deciding deny.
 */
export type DenySuggestion =
	| { status: "no-deny" }
	| { status: "dead-end"; deny: PermissionRule }
	| { status: "override"; deny: PermissionRule; allow: DenyOverride };

const BASH_COMMAND_ARGS = (command: string): Record<string, unknown> => ({ command });

/** Deny-error suggestion for a bash command (spec §5.2): {@link denySuggestion} over the command argument. */
export function denyOverrideSuggestion(command: string, ctx: EngineContext): DenySuggestion {
	return denySuggestion("bash", BASH_COMMAND_ARGS(command), ctx);
}

/**
 * Deny-error suggestion (spec §5.2): when a deny decides, the best allow-only
 * whole-command match that strictly beats the best matching deny by class then
 * specificity — the exact rule the user can add to permit this call. See
 * {@link DenySuggestion} for the three outcomes.
 *
 * The rule pool mirrors the runtime decision pool (evaluatePermissionCore):
 * the legacy `bash.patterns` pool joins the file-backed rules for bash, so the
 * suggestion judges against the ACTUAL deciding deny, including legacy denies.
 * Whole-command matching only — a deny that decided a pipeline stage rather
 * than the whole command is not surfaced here.
 */
export function denySuggestion(toolName: string, args: unknown, ctx: EngineContext): DenySuggestion {
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	const legacy = legacyBashPatterns(ctx.settings);
	const command = bashCommandArg(args);
	const legacyAllowActive = toolName === "bash" && command !== undefined && isSinglePiece(command);
	const pool = [
		...legacy.filter(rule => rule.action !== "allow" || legacyAllowActive),
		...rules,
		...sessionRules(sessionRuleKey(ctx)),
	];
	const bestDeny = resolveWholeCommandRule(
		pool.filter(rule => rule.action === "deny"),
		toolName,
		args,
	);
	if (bestDeny === undefined) return { status: "no-deny" };
	const bestAllow = resolveWholeCommandRule(
		pool.filter(rule => rule.action === "allow"),
		toolName,
		args,
	);
	if (bestAllow === undefined) return { status: "dead-end", deny: bestDeny.rule };
	const classRank = (matchClass: MatchClass): number => (matchClass === "exact-structure" ? 1 : 0);
	const beats =
		classRank(bestAllow.matchClass) !== classRank(bestDeny.matchClass)
			? classRank(bestAllow.matchClass) > classRank(bestDeny.matchClass)
			: bestAllow.specificity > bestDeny.specificity;
	if (!beats) return { status: "dead-end", deny: bestDeny.rule };
	return {
		status: "override",
		deny: bestDeny.rule,
		allow: { rule: bestAllow.rule, matchClass: bestAllow.matchClass, specificity: bestAllow.specificity },
	};
}
