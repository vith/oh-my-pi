/**
 * Approval prompt flow with rule candidates (spec §5).
 *
 * Replaces the binary Approve/Deny prompt: bash calls with several pieces show
 * ONE compound dialog for the whole call — Allow all pending once / Allow all
 * & remember… / Deny all pending / Decide per piece → — with a per-piece
 * drill-down (piece selector, then the single-unit prompt for that piece; a
 * Deny once on a piece denies the whole call, undecided remainders fail
 * closed to deny). PTY calls, non-bash calls, forced prompts, and single-piece
 * calls keep the single-unit flow: per pending piece the user picks from
 * Allow once / Allow & remember… / Deny / Deny & remember…, then a scope-level
 * choice of candidate rules (exact, pattern, custom, tool-wide for read-only
 * tools) that preview the exact YAML they write. Remembering writes a
 * user-layer rule.
 *
 * PTY calls (spec §4.3) cannot be execution-split: they prompt once for the
 * whole command, with candidates scoped to the whole command text.
 */
import * as path from "node:path";
import { YAML } from "bun";
import type {
	ExtensionUIContext,
	PermissionDialogLine,
	PermissionDialogOption,
	PermissionDialogRequest,
} from "../../extensibility/extensions/types";
import { CURATED_ALLOW_TOOLS, isSafeConsumerStage } from "./curated";
import {
	denyOverrideSuggestion,
	denySuggestion,
	type EngineContext,
	type EngineDecision,
	evaluateBashCommand,
	hasBashApprovalShellControl,
	matchPatternValue,
	matchRule,
	nearMissLine,
	type PieceEvaluation,
} from "./engine";
import { type PermissionRule, type RuleAction, ruleFiles, writeUserRule } from "./rules";
import { addSessionRule, sessionRuleKey } from "./session-rules";
import { extractSubCommands } from "./split";
import type { Recommendation, RecommendationScope, Suggestion, SuggestionProvider, SuggestResult } from "./suggest";

/** A selectable rule candidate: the label the user sees, the YAML preview, and the rule to write. */
export interface CandidateRule {
	label: string;
	yaml: string;
	rule: Omit<PermissionRule, "layer">;
	/** The remember scope (spec §5.1) this candidate writes; lets chooseCandidate preselect Pattern. */
	scope: CandidateScope;
}

/** Outcome of the whole approval prompt: the policy, plus the rule remembered (if any). */
export interface PromptResolution {
	policy: "allow" | "deny";
	remembered?: Omit<PermissionRule, "layer">;
}

export interface PromptForDecisionOptions {
	/** Formatted approval prompt (tool name, reason, provider safety checks) shown as the dialog title. */
	title?: string;
	/**
	 * Approval reason carried into the v3 dialog lines (metadata, alongside
	 * the tool line). The wrapper passes the gate's reason here instead of
	 * overriding the v3 title with the legacy prompt format.
	 */
	approvalReason?: string;
	/**
	 * The tool's `formatApprovalDetails` lines, appended to the v3 dialog
	 * metadata (legacy titles showed them; the v3 dialog carries them in its
	 * lines).
	 */
	approvalDetails?: string | readonly string[];
	/**
	 * When false the dialog offers only Approve/Deny with no candidates and no
	 * remember options (provider safety-check forced prompts).
	 */
	includeCandidates?: boolean;
	/**
	 * Model-decided approval provider (spec §5.3): per pending unit the flow
	 * fires it while the dialog is shown. Its recommendation preselects the
	 * dialog option when it lands (auto-mode-with-confirmation); its rule
	 * suggestions append as extra options behind the dialog's spinner. Any
	 * provider failure degrades to candidates-only with no preselection.
	 * Never called for forced prompts (`includeCandidates: false`).
	 */
	suggestionsProvider?: SuggestionProvider;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const ALLOW_REMEMBER = "Allow & remember…";
const DENY = "Deny";
const DENY_REMEMBER = "Deny & remember…";
const APPROVE = "Approve";

/** v3 compound-dialog actions (spec §5.1): one dialog for the whole call. */
const ALLOW_ALL_ONCE = "Allow all pending once";
const ALLOW_ALL_SESSION = "Allow all for this session";
const ALLOW_ALL_REMEMBER = "Allow all & remember…";
const DENY_ALL = "Deny all pending";
const DRILL_DOWN = "Decide per piece →";

/**
 * Dialog note shown when a bash command's remember options are suppressed:
 * the engine degrades rule-based allows on shell-control commands to a prompt
 * (ruling R1), so a remembered rule would never suppress this prompt.
 */
const BASH_SHELL_CONTROL_NOTE =
	"Remembered rules cannot suppress this prompt: the command uses shell control that rules cannot analyze (redirect, -c/-e/-Command//c reinterpretation, or an unanalyzable construct).";

/**
 * Dialog note shown when a tool's remember options are suppressed because
 * every candidate scope is exact (one-shot code tools like eval): a
 * remembered rule would only ever match an identical call.
 */
const EXACT_ONLY_REMEMBER_NOTE =
	"Remembering this call would only match an identical call — no pattern scope applies to this tool. Allow for this session has the same reach, without writing a rule.";

/** Whether the prompt unit's bash command carries unanalyzable shell control (remember rules cannot suppress it). */
function bashRememberDisabled(args: unknown): boolean {
	const command = argString(args, "command");
	if (command === undefined || command.length === 0) return false;
	// Residue control (redirects, interpreter reinterpreting options) plus
	// constructs extraction cannot analyze degrade remember options; analyzable
	// pipelines/substitutions keep them (the engine evaluates their sub-commands).
	return hasBashApprovalShellControl(command) || extractSubCommands(command) === null;
}

/** Legacy fake-UI label from the pre-dialog binary prompt, tolerated for compatibility. */
const LEGACY_APPROVE = "Approve";

const FILE_ARG_KEYS = ["path", "file"] as const;

function argString(args: unknown, key: string): string | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function isPtyCall(args: unknown): boolean {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
	return (args as Record<string, unknown>).pty === true;
}

function stringEntries(args: unknown): Record<string, string> {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return {};
	const entries: Record<string, string> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > 0) entries[key] = value;
	}
	return entries;
}

/** Candidate scopes (spec §5.1); part of the id so exact/pattern/tool never collide. */
type CandidateScope = "exact" | "pattern" | "tool";

/** Deterministic per-candidate id so re-remembering the same rule replaces it. */
function candidateRuleId(
	tool: string,
	scope: CandidateScope,
	match: Record<string, unknown>,
	action: RuleAction,
): string {
	const slug = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	const matchSlug = slug(Object.values(match).join("-")).slice(0, 24) || "all";
	return `remember-${slug(tool)}-${scope}-${matchSlug}-${action}`;
}

/**
 * The exact YAML block the user sees and that gets written for a rule.
 * Matches `writeUserRule`'s entry shape so `normalizeRule` round-trips it.
 */
export function renderCandidateYaml(rule: Omit<PermissionRule, "layer">): string {
	const entry: Record<string, unknown> = {
		id: rule.id,
		tool: rule.tool,
		match: rule.match,
		action: rule.action,
	};
	if (rule.reason !== undefined) entry.reason = rule.reason;
	if (rule.ttl !== undefined) entry.ttl = rule.ttl;
	return YAML.stringify(entry);
}

function candidate(
	toolName: string,
	action: RuleAction,
	scope: CandidateScope,
	match: Record<string, unknown>,
	label: string,
): CandidateRule {
	const rule: Omit<PermissionRule, "layer"> = {
		id: candidateRuleId(toolName, scope, match, action),
		tool: toolName,
		match,
		action,
	};
	return { label, yaml: renderCandidateYaml(rule), rule, scope };
}

/** Tool-always scope is offered only for read-only tools (spec §5.1); never for bash/exec tools. */
function toolWideAllowed(toolName: string): boolean {
	return (CURATED_ALLOW_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Commands whose first token dispatches to subcommands: a bare first-token
 * pattern (`git *`) would also cover destructive variants like git push, rm,
 * reset, or clean, so their remember pattern takes the subcommand verb too
 * (`git log *`). Everything else keeps the bare first-token pattern
 * (`echo *`).
 */
const SUBCOMMAND_COMMANDS: ReadonlySet<string> = new Set([
	"git",
	"npm",
	"bun",
	"cargo",
	"docker",
	"gh",
	"pnpm",
	"yarn",
	"brew",
	"apt",
	"apt-get",
	"pacman",
	"dnf",
	"make",
	"cmake",
	"kubectl",
	"helm",
	"terraform",
	"go",
	"rustup",
	"pip",
	"pip3",
	"uv",
]);

/**
 * First-token remember pattern (spec §5.1): `git log *` when the first token
 * dispatches subcommands (and a subcommand is present), `git *` for a bare
 * subcommand-verb invocation, `echo *` otherwise.
 */
function firstTokenPattern(command: string): string {
	const tokens = command.trim().split(/\s+/u);
	const first = tokens[0] ?? "";
	const second = tokens[1];
	if (second !== undefined && SUBCOMMAND_COMMANDS.has(first)) {
		return `${first} ${second} *`;
	}
	return `${first} *`;
}

/** bash: exact command, first-token pattern (`git log *`), tool-wide only for read-only tools (never bash). */
function bashCandidates(toolName: string, command: string, action: RuleAction): CandidateRule[] {
	const pattern = firstTokenPattern(command);
	const deny = action === "deny";
	const candidates: CandidateRule[] = [
		candidate(toolName, action, "exact", { command }, `${deny ? "Deny exact" : "Exact"}: ${command}`),
		candidate(toolName, action, "pattern", { command: pattern }, `${deny ? "Deny pattern" : "Pattern"}: ${pattern}`),
	];
	if (toolWideAllowed(toolName)) {
		candidates.push(
			candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
		);
	}
	return candidates;
}

/** file tools: exact path, parent-dir glob (`src/**`), tool-wide only for read-only tools. */
function fileCandidates(toolName: string, key: string, fileArg: string, action: RuleAction): CandidateRule[] {
	const parent = path.dirname(fileArg);
	const glob = parent === "." ? "./**" : `${parent}/**`;
	const deny = action === "deny";
	const candidates: CandidateRule[] = [
		candidate(toolName, action, "exact", { [key]: fileArg }, `${deny ? "Deny exact" : "Exact"}: ${fileArg}`),
		candidate(toolName, action, "pattern", { [key]: glob }, `${deny ? "Deny pattern" : "Pattern"}: ${glob}`),
	];
	if (toolWideAllowed(toolName)) {
		candidates.push(
			candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
		);
	}
	return candidates;
}

/** others: exact args + tool-wide only for read-only tools. */
function genericCandidates(toolName: string, args: unknown, action: RuleAction): CandidateRule[] {
	const exactArgs = stringEntries(args);
	const deny = action === "deny";
	const candidates: CandidateRule[] = [];
	if (Object.keys(exactArgs).length > 0) {
		candidates.push(candidate(toolName, action, "exact", exactArgs, deny ? "Deny exact call" : "Exact call"));
	}
	if (toolWideAllowed(toolName)) {
		candidates.push(
			candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
		);
	}
	return candidates;
}

function scopedCandidates(toolName: string, args: unknown, action: RuleAction): CandidateRule[] {
	const command = argString(args, "command");
	if (command !== undefined && command.length > 0) {
		// Shell-control commands degrade rule-based allows to a prompt (engine
		// ruling R1) and whole-command matches never see per-piece evaluation,
		// so exact/pattern/tool remember rules can never suppress them. Omit
		// the candidates entirely — the dialog keeps Allow once + Deny with a
		// note (spec §5.1).
		if (hasBashApprovalShellControl(command)) return [];
		return bashCandidates(toolName, command, action);
	}
	for (const key of FILE_ARG_KEYS) {
		const fileArg = argString(args, key);
		if (fileArg !== undefined && fileArg.length > 0) {
			return fileCandidates(toolName, key, fileArg, action);
		}
	}
	return genericCandidates(toolName, args, action);
}

/**
 * Build the candidate rules for a pending call (spec §5.1 scopes). Deny
 * candidates are offered with the same scopes only while a piece is pending —
 * never for hard-denied calls. `pieces` undefined means the whole call is the
 * prompt unit (always pending), so deny candidates are included.
 */
export function buildCandidates(toolName: string, args: unknown, pieces?: PieceEvaluation[]): CandidateRule[] {
	const allow = scopedCandidates(toolName, args, "allow");
	const pending = pieces === undefined || pieces.some(piece => piece.policy === "prompt");
	return pending ? [...allow, ...scopedCandidates(toolName, args, "deny")] : allow;
}

/**
 * The model-visible allow suggestion for a denied call (spec §5.2). Shell-
 * control bash commands can never be unblocked by a rule (R1 degrades allow
 * winners to a prompt), so they get the accurate message BEFORE any override
 * consultation. Otherwise the engine's suggestion decides: an allow that
 * strictly beats the deciding deny renders its exact YAML and why; a deny
 * nothing beats renders the dead end; a posture-source deny (no deny rule
 * matched — a rule allow beats the posture) suggests the mechanical first
 * candidate. Non-bash calls go through the same dead-end/override gate so a
 * tying or losing candidate is never suggested.
 */
export function renderAllowSuggestion(toolName: string, args: unknown, ctx: EngineContext): string {
	const command = argString(args, "command");
	if (toolName === "bash" && command !== undefined && hasBashApprovalShellControl(command)) {
		return "No rule can allow this call: the command uses shell control, which no remembered allow rule can suppress.";
	}
	const suggestion =
		toolName === "bash" && command !== undefined && command.length > 0
			? denyOverrideSuggestion(command, ctx)
			: denySuggestion(toolName, args, ctx);
	if (suggestion.status === "override") {
		const rule = { ...suggestion.allow.rule } as Omit<PermissionRule, "layer">;
		return (
			`This call is denied by ${suggestion.deny.id}. To permit it, add this rule ` +
			`(more specific than the deny, class ${suggestion.allow.matchClass}):\n${renderCandidateYaml(rule)}`
		);
	}
	if (suggestion.status === "dead-end") {
		return "This call is denied, and no allow rule can override the matching deny. Add a more specific allow rule (same command shape, more literal tokens) via /permissions add, or change the deny.";
	}
	// No deny rule matched (posture-source deny): a rule allow beats the
	// posture, so the mechanical first candidate is exactly what unblocks it.
	const first = buildCandidates(toolName, args)[0];
	if (first === undefined) {
		return "No rule can allow this call: the command uses shell control, which no remembered allow rule can suppress.";
	}
	return `To allow this call, add rule:\n${first.yaml}`;
}

/** v3 dialog title (spec §5.1): the question, not the legacy "Allow tool" format. */
function defaultTitle(toolName: string): string {
	return toolName === "bash" ? "Approve this command?" : `Approve ${toolName} call?`;
}

/** v3 dialog metadata lines: the tool being approved, the approval reason, and the tool's details. */
function dialogMetadataLines(toolName: string, opts: PromptForDecisionOptions): PermissionDialogLine[] {
	const lines: PermissionDialogLine[] = [{ segments: [{ text: `tool: ${toolName}` }], style: "muted" }];
	if (opts.approvalReason !== undefined && opts.approvalReason.length > 0) {
		lines.push({ segments: [{ text: `reason: ${opts.approvalReason}` }], style: "muted" });
	}
	const details = opts.approvalDetails;
	if (typeof details === "string") {
		if (details.length > 0) lines.push({ segments: [{ text: details }], style: "muted" });
	} else if (Array.isArray(details)) {
		for (const detail of details) {
			if (detail.length > 0) lines.push({ segments: [{ text: detail }], style: "muted" });
		}
	}
	return lines;
}

/** Plain-text rendering of the metadata block, for legacy select surfaces that only show a title. */
function metadataText(lines: PermissionDialogLine[]): string {
	return lines.map(line => line.segments.map(segment => segment.text).join("")).join("\n");
}

/**
 * The v3 dialog title; legacy select surfaces (no showPermissionDialog) only
 * render the title, so the metadata block folds in there to keep the pending
 * call identifiable.
 */
function dialogTitle(ui: ExtensionUIContext, title: string, metaLines: PermissionDialogLine[]): string {
	if (ui.showPermissionDialog !== undefined || metaLines.length === 0) return title;
	return `${title}\n${metadataText(metaLines)}`;
}

export function pieceStatusText(piece: PieceEvaluation): { text: string; style?: "muted" | "text" | "accent" } {
	if (piece.policy === "allow") {
		if (piece.ruleId === undefined) return { text: "allowed" };
		return { text: `allowed · ${piece.layer ?? "rule"} rule ${piece.ruleId}`, style: "muted" };
	}
	if (piece.policy === "deny") return { text: "denied", style: "accent" };
	return piece.ruleId !== undefined
		? { text: `prompt · rule ${piece.ruleId}`, style: "accent" }
		: { text: "no rule", style: "accent" };
}

/** Split a piece at its last pipe; the tail is dimmable when it is a safe consumer. */
export function splitSafeTail(text: string): { prefix: string; tail?: string } {
	const pipeIndex = text.lastIndexOf("|");
	if (pipeIndex < 0) return { prefix: text };
	const tail = text.slice(pipeIndex).trim();
	// The tokenizer glues the pipe to the stage ("… |head -1"); the consumer
	// check reads the stage text, so strip the leading pipe (plan ruling).
	if (tail.length === 0 || !isSafeConsumerStage(tail.replace(/^\|/u, ""))) return { prefix: text };
	return { prefix: text.slice(0, pipeIndex).trimEnd(), tail: ` ${tail}` };
}

/** v3 dialog lines (spec §5.1): summary, operator-prefixed piece rows, dim safe tails, near-miss. */
export function buildDialogLines(
	decision: EngineDecision,
	pieces: PieceEvaluation[] | undefined,
	ctx?: EngineContext,
): PermissionDialogLine[] {
	const lines: PermissionDialogLine[] = [];
	if (pieces !== undefined && pieces.length > 0) {
		const pending = pieces.filter(piece => piece.policy === "prompt").length;
		if (pieces.length > 1) {
			lines.push({
				segments: [{ text: `${pending} of ${pieces.length} pieces need approval — no rule covers this command` }],
				style: "accent",
			});
		}
		for (const [index, piece] of pieces.entries()) {
			const { prefix, tail } = splitSafeTail(piece.text);
			const segments: Array<{ text: string; dim?: boolean }> = [];
			const operator =
				index > 0 && piece.operator !== undefined && piece.operator !== null ? `${piece.operator} ` : "";
			segments.push({ text: `${operator}${prefix}` });
			if (tail !== undefined) segments.push({ text: tail, dim: true });
			const status = pieceStatusText(piece);
			const line: PermissionDialogLine = {
				segments,
				style: piece.policy === "allow" ? "allowed" : piece.policy === "deny" ? "denied" : "text",
				status,
			};
			lines.push(line);
			if (piece.policy === "prompt" && ctx !== undefined) {
				const miss = nearMissLine(piece.text, ctx);
				if (miss !== undefined) lines.push({ segments: [{ text: miss }], style: "muted" });
			}
		}
		return lines;
	}
	// Single-unit (non-bash / PTY) context line, v3 wording.
	lines.push({
		segments: [
			{
				text:
					decision.ruleId !== undefined
						? `rule ${decision.ruleId}${decision.layer ? ` (${decision.layer})` : ""}`
						: "no rule",
			},
		],
		style: decision.ruleId !== undefined ? "muted" : "accent",
	});
	return lines;
}

/** The dialog label for a suggestion: `Allow bash: git push`. */
function suggestionLabel(suggestion: Suggestion): string {
	const verb = suggestion.rule.action === "allow" ? "Allow" : "Deny";
	const matchText = Object.values(suggestion.rule.match).join(", ");
	return `${verb} ${suggestion.rule.tool}: ${matchText}`;
}

/** The pending-call text handed to the suggestions provider for one prompt unit. */
function unitPieceText(toolName: string, unitArgs: unknown): string {
	if (toolName === "bash") {
		const command = argString(unitArgs, "command");
		if (command !== undefined) return command;
	}
	return `${toolName} ${JSON.stringify(unitArgs)}`;
}

/** The provider result shaped for both the dialog options and label routing. */
interface ResolvedSuggestions {
	result: SuggestResult;
	options: PermissionDialogOption[];
	byLabel: Map<string, Suggestion>;
}

const EMPTY_SUGGESTIONS: ResolvedSuggestions = {
	result: { suggestions: [] },
	options: [],
	byLabel: new Map<string, Suggestion>(),
};

/**
 * Shape the provider result into dialog options. Suggestions that cannot
 * match the pending call are dropped: accepting them would append options
 * that write never-matching rules. A suggestion matches when its rule matches
 * the call's args, or — for compound bash calls — any pending piece's command
 * text (the rule may cover the piece needing approval without covering the
 * whole compound string).
 */
function resolveSuggestions(
	result: SuggestResult,
	toolName: string,
	args: unknown,
	pendingPieces?: PieceEvaluation[],
): ResolvedSuggestions {
	const kept: Suggestion[] = [];
	for (const suggestion of result.suggestions) {
		const rule = { ...suggestion.rule, layer: "user" } as PermissionRule;
		if (matchRule(rule, toolName, args)) {
			kept.push(suggestion);
		} else if (pendingPieces !== undefined && toolName === "bash") {
			const matchesPiece = pendingPieces.some(piece => matchRule(rule, "bash", { command: piece.text }));
			if (matchesPiece) kept.push(suggestion);
		}
	}
	const seen = new Set<string>();
	const options: PermissionDialogOption[] = [];
	const byLabel = new Map<string, Suggestion>();
	for (const suggestion of kept) {
		const label = suggestionLabel(suggestion);
		if (seen.has(label)) continue; // duplicate labels would be unroutable
		seen.add(label);
		options.push({ label, description: renderCandidateYaml(suggestion.rule) });
		byLabel.set(label, suggestion);
	}
	return { result: { ...result, suggestions: kept }, options, byLabel };
}

/**
 * Map the model's recommendation to the decision-page option index; the
 * recommended label not being offered (remember dropped) falls back to the
 * same-polarity least-commitment action. `undefined` = no preselection.
 */
function decisionRecommendationIndex(
	recommendation: Recommendation | undefined,
	options: readonly string[],
): number | undefined {
	if (recommendation === undefined) return undefined;
	const remember = recommendation.scope !== "once";
	const label =
		recommendation.action === "allow" ? (remember ? ALLOW_REMEMBER : ALLOW_ONCE) : remember ? DENY_REMEMBER : DENY;
	const index = options.indexOf(label);
	if (index >= 0) return index;
	const fallback = recommendation.action === "allow" ? ALLOW_ONCE : DENY;
	const fallbackIndex = options.indexOf(fallback);
	return fallbackIndex >= 0 ? fallbackIndex : undefined;
}

/** Compound-page variant: allow-all-once / allow-all-remember / deny-all. */
function compoundRecommendationIndex(
	recommendation: Recommendation | undefined,
	options: readonly string[],
): number | undefined {
	if (recommendation === undefined) return undefined;
	const label =
		recommendation.action === "deny"
			? DENY_ALL
			: recommendation.scope === "once"
				? ALLOW_ALL_ONCE
				: ALLOW_ALL_REMEMBER;
	const index = options.indexOf(label);
	if (index >= 0) return index;
	const fallback = recommendation.action === "allow" ? ALLOW_ALL_ONCE : DENY_ALL;
	const fallbackIndex = options.indexOf(fallback);
	return fallbackIndex >= 0 ? fallbackIndex : undefined;
}

/** The option-list index of the first candidate with `scope` (Custom… rows count). */
function candidateOptionIndex(candidates: CandidateRule[], scope: RecommendationScope): number | undefined {
	let optionIndex = 0;
	for (const candidateItem of candidates) {
		if (candidateItem.scope === scope) return optionIndex;
		optionIndex += 1;
		if (candidateItem.scope === "pattern") optionIndex += 1; // Custom… follows a pattern
	}
	return undefined;
}

/** Dialog presentation options for {@link chooseLabel}. */
interface ChooseLabelDialogOpts {
	/** Row to preselect; omitted = no selection. */
	initialIndex?: number;
	/** Resolves to the row to preselect once the model's recommendation lands. */
	preselect?: Promise<number | undefined>;
	/** Help line shown at the bottom of the dialog. */
	helpText?: string;
}

/** Present an option list, mapping the choice back to its label. Cancel → undefined. */
async function chooseLabel(
	ui: ExtensionUIContext,
	title: string,
	options: string[],
	lines?: readonly (string | PermissionDialogLine)[],
	suggestions?: Promise<PermissionDialogOption[]>,
	dialogOpts?: ChooseLabelDialogOpts,
): Promise<string | undefined> {
	if (ui.showPermissionDialog) {
		const request: PermissionDialogRequest = {
			title,
			...((lines?.length ?? 0) > 0 ? { lines } : {}),
			options: options.map(label => ({ label })),
			...(suggestions !== undefined ? { suggestions } : {}),
			...(dialogOpts?.initialIndex !== undefined ? { initialIndex: dialogOpts.initialIndex } : {}),
			...(dialogOpts?.preselect !== undefined ? { preselect: dialogOpts.preselect } : {}),
			...(dialogOpts?.helpText !== undefined ? { helpText: dialogOpts.helpText } : {}),
		};
		const index = await ui.showPermissionDialog(request);
		if (index === undefined) return undefined;
		const base = options[index];
		if (base !== undefined) return base;
		// The picked option is one the dialog appended after it opened.
		if (suggestions === undefined) return undefined;
		const appended = await suggestions;
		return appended[index - options.length]?.label;
	}
	return ui.select(title, [...options]);
}

/** The single-piece scope dialog's glob-edit option (spec §5.1). */
const CUSTOM_LABEL = "Custom…";

/** The scope dialog's back-to-decision-page signal (esc / cancel). */
const SCOPE_BACK = "back" as const;

/**
 * Level-2 scope choice: pick a candidate (with its YAML preview), edit via
 * Custom…, or go back. `recommendedScope` resolves to the model's recommended
 * scope for this call, preselected when it lands; without a recommendation
 * the Pattern candidate stays preselected (the one that will fire again).
 */
async function chooseCandidate(
	ui: ExtensionUIContext,
	title: string,
	candidates: CandidateRule[],
	recommendedScope: Promise<RecommendationScope | undefined> | undefined,
	args: unknown,
): Promise<CandidateRule | typeof SCOPE_BACK | undefined> {
	if (candidates.length === 0) return SCOPE_BACK;
	if (ui.showPermissionDialog) {
		const options: PermissionDialogOption[] = [];
		for (const candidateItem of candidates) {
			options.push({ label: candidateItem.label, description: candidateItem.yaml });
			// Custom… sits right after Pattern (spec §5.1): the disagreement
			// escape edits the recommended glob, narrower or wider.
			if (candidateItem.scope === "pattern") options.push({ label: CUSTOM_LABEL });
		}
		const request: PermissionDialogRequest = {
			title,
			options,
			// The Pattern candidate (the one that will fire again) is
			// preselected; exact-only candidate lists preselect the exact rule.
			initialIndex: Math.max(
				0,
				candidates.findIndex(candidateItem => candidateItem.scope === "pattern"),
			),
			helpText: "j/k navigate  enter select  esc back",
			...(recommendedScope !== undefined
				? {
						preselect: recommendedScope.then(scope =>
							scope === undefined ? undefined : candidateOptionIndex(candidates, scope),
						),
					}
				: {}),
		};
		const index = await ui.showPermissionDialog(request);
		if (index === undefined || index === -1) return SCOPE_BACK; // esc — back to the decision page
		// The option list inserts Custom… between candidates, so the picked
		// index does not map onto the candidates array — resolve by label.
		const label = options[index]?.label;
		if (label === CUSTOM_LABEL) return editCustomCandidate(ui, title, candidates, args);
		const found = candidates.find(candidateItem => candidateItem.label === label);
		return found;
	}
	const labels = [
		...candidates.map(candidateItem => candidateItem.label),
		...(candidates.some(candidateItem => candidateItem.scope === "pattern") ? [CUSTOM_LABEL] : []),
	];
	const label = await ui.select(title, labels);
	if (label === undefined) return SCOPE_BACK;
	if (label === CUSTOM_LABEL) return editCustomCandidate(ui, title, candidates, args);
	const index = candidates.findIndex(candidateItem => candidateItem.label === label);
	return index >= 0 ? candidates[index] : undefined;
}

/**
 * Custom… (spec §5.1): edit the recommended pattern glob via `ui.input`,
 * returning a pattern-scope candidate for the caller to write. Cancel/empty
 * edits resolve to undefined (no rule).
 *
 * The edited pattern is validated against the pending call's value before
 * acceptance: a pattern that cannot match this call (e.g. a `~` path the
 * engine cannot see, a glob narrower than the actual target) would write a
 * rule that never fires. On mismatch the input reopens with an error
 * notification so the user can fix the glob or esc to abandon.
 */
async function editCustomCandidate(
	ui: ExtensionUIContext,
	title: string,
	candidates: CandidateRule[],
	args: unknown,
): Promise<CandidateRule | undefined> {
	if (ui.input === undefined) return undefined;
	const recommended = candidates.find(candidateItem => candidateItem.scope === "pattern");
	if (recommended === undefined) return undefined; // Custom… is only offered next to a Pattern
	const matchKey = Object.keys(recommended.rule.match)[0] ?? "command";
	const current = String(recommended.rule.match[matchKey] ?? "");
	const pendingValue = argString(args, matchKey);
	let edited = await ui.input(`Edit pattern (${title})`, current);
	while (edited !== undefined && edited.trim().length > 0) {
		const value = edited.trim();
		// No pending value for this key (should not happen — Custom… only
		// follows a Pattern candidate whose key exists in the call): accept
		// without validation rather than blocking on a phantom mismatch.
		if (pendingValue === undefined || matchPatternValue(matchKey, pendingValue, value)) {
			const deny = recommended.rule.action === "deny";
			return candidate(
				recommended.rule.tool,
				recommended.rule.action,
				"pattern",
				{ [matchKey]: value },
				`${deny ? "Deny pattern" : "Pattern"}: ${value}`,
			);
		}
		ui.notify(`This pattern cannot match the pending call — it would never fire: ${value}`, "error");
		edited = await ui.input(`Edit pattern (${title}) — pattern does not match this call`, value);
	}
	return undefined;
}

async function writeRememberedRule(rule: Omit<PermissionRule, "layer">, ctx: EngineContext): Promise<void> {
	await writeUserRule(ruleFiles(ctx.cwd, ctx.home).user, rule);
}

/** PromptUnit outcome: a normal resolution, or the drill-down's back-to-selector signal. */
type PromptUnitResult = PromptResolution | { policy: "back" };

/** Prompt for one unit (a pending bash piece, the whole call, or a whole PTY command). */
async function promptUnit(
	ui: ExtensionUIContext,
	toolName: string,
	unitArgs: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
	pieces: PieceEvaluation[] | undefined,
): Promise<PromptResolution>;
/** Drill-down variant: the per-piece dialog also offers the back-to-selector option. */
async function promptUnit(
	ui: ExtensionUIContext,
	toolName: string,
	unitArgs: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
	pieces: PieceEvaluation[] | undefined,
	backLabel: string,
): Promise<PromptUnitResult>;
async function promptUnit(
	ui: ExtensionUIContext,
	toolName: string,
	unitArgs: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
	pieces: PieceEvaluation[] | undefined,
	backLabel?: string,
): Promise<PromptUnitResult> {
	const title = opts.title ?? defaultTitle(toolName);

	if (opts.includeCandidates === false) {
		// Provider safety-check forced prompt: no candidates, binary choice
		// only; Approve is preselected (auto-mode-with-confirmation).
		const chosen = await chooseLabel(ui, title, [APPROVE, DENY], buildDialogLines(decision, pieces, ctx), undefined, {
			initialIndex: 0,
		});
		const approved = chosen === APPROVE || chosen === ALLOW_ONCE;
		return { policy: approved ? "allow" : "deny" };
	}

	const candidates = buildCandidates(toolName, unitArgs, pieces);
	// The forced-prompt branch above already returned, so only candidate
	// dialogs reach here; the provider fires once per pending unit and its
	// recommendation drives the dialog preselection.
	const suggestionFlow =
		opts.suggestionsProvider !== undefined
			? opts
					.suggestionsProvider(unitPieceText(toolName, unitArgs))
					.then(resolved => resolveSuggestions(resolved, toolName, unitArgs, pieces))
					.catch(() => EMPTY_SUGGESTIONS)
			: undefined;
	// Shell-control bash commands cannot be suppressed by a remembered rule,
	// and tools whose candidates are exact-only (one-shot code tools like
	// eval) can only remember an identical call — drop the remember options
	// for both and say why. "Allow for this session" is an in-memory rule:
	// it survives exact-only tools (an identical re-run is exactly what it
	// covers) but is useless under shell control, where rule-backed allows
	// degrade to a prompt (R1) — so it drops there too.
	const rememberDisabled = bashRememberDisabled(unitArgs);
	const exactOnlyRemember =
		candidates.length > 0 && candidates.every(candidateItem => candidateItem.scope === "exact");
	const metaLines = dialogMetadataLines(toolName, opts);
	const lines: (string | PermissionDialogLine)[] = [...metaLines, ...buildDialogLines(decision, pieces, ctx)];
	if (rememberDisabled) {
		lines.push("", BASH_SHELL_CONTROL_NOTE);
	} else if (exactOnlyRemember) {
		lines.push("", EXACT_ONLY_REMEMBER_NOTE);
	}
	const baseOptions = rememberDisabled
		? [ALLOW_ONCE, DENY]
		: exactOnlyRemember
			? [ALLOW_ONCE, ALLOW_SESSION, DENY]
			: [ALLOW_ONCE, ALLOW_SESSION, ALLOW_REMEMBER, DENY, DENY_REMEMBER];
	const options = backLabel !== undefined ? [...baseOptions, backLabel] : baseOptions;
	// The model's recommendation preselects the decision-page option when it
	// lands; until then the dialog shows no selection (auto-mode-with-
	// confirmation — the model decides, the user confirms).
	const recommendedScope = suggestionFlow?.then(resolved => resolved.result.recommendation?.scope);
	const preselect = suggestionFlow?.then(resolved =>
		decisionRecommendationIndex(resolved.result.recommendation, options),
	);
	while (true) {
		const chosen = await chooseLabel(
			ui,
			dialogTitle(ui, title, metaLines),
			options,
			lines,
			suggestionFlow?.then(result => result.options),
			{ ...(preselect !== undefined ? { preselect } : {}) },
		);
		switch (chosen) {
			case ALLOW_ONCE:
			case LEGACY_APPROVE: // pre-dialog fake UI / older callers
				return { policy: "allow" };
			case DENY:
				return { policy: "deny" };
			case ALLOW_SESSION: {
				// In-memory session-scoped allow: the pattern candidate when
				// available (covers the call family for the rest of the
				// session), else the exact one. Nothing is written to disk.
				const allow = candidates.filter(candidateItem => candidateItem.rule.action === "allow");
				const recommended = allow.find(candidateItem => candidateItem.scope === "pattern") ?? allow[0];
				if (recommended === undefined) return { policy: "deny" };
				addSessionRule(sessionRuleKey(ctx), sessionRule(recommended.rule));
				return { policy: "allow" };
			}
			case ALLOW_REMEMBER: {
				const rule = await chooseCandidate(
					ui,
					`Remember an allow rule for ${toolName}`,
					candidates.filter(candidateItem => candidateItem.rule.action === "allow"),
					recommendedScope,
					unitArgs,
				);
				// Esc on the scope page returns to the decision page; a
				// cancelled Custom… glob edit does the same.
				if (rule === SCOPE_BACK || rule === undefined) continue;
				await writeRememberedRule(rule.rule, ctx);
				return { policy: "allow", remembered: rule.rule };
			}
			case DENY_REMEMBER: {
				const rule = await chooseCandidate(
					ui,
					`Remember a deny rule for ${toolName}`,
					candidates.filter(candidateItem => candidateItem.rule.action === "deny"),
					recommendedScope,
					unitArgs,
				);
				if (rule === SCOPE_BACK || rule === undefined) continue;
				await writeRememberedRule(rule.rule, ctx);
				return { policy: "deny", remembered: rule.rule };
			}
			default: {
				// Drill-down navigation: return to the piece selector, undecided.
				if (backLabel !== undefined && chosen === backLabel) return { policy: "back" };
				// A suggestion option picked from the dialog: remember its rule
				// and resolve with its action. Unknown labels (incl. esc) still
				// fail closed.
				if (chosen !== undefined && suggestionFlow !== undefined) {
					const picked = (await suggestionFlow).byLabel.get(chosen);
					if (picked !== undefined) {
						await writeRememberedRule(picked.rule, ctx);
						return { policy: picked.rule.action === "allow" ? "allow" : "deny", remembered: picked.rule };
					}
				}
				return { policy: "deny" };
			}
		}
	}
}

/**
 * Give a remember-scoped candidate rule its session-layer identity: same
 * match, action, and reason, but a `session-` id so audit attribution and
 * the store display read as ephemeral rather than file-backed.
 */
function sessionRule(rule: Omit<PermissionRule, "layer">): Omit<PermissionRule, "layer"> {
	return { ...rule, id: `session-${rule.id.replace(/^remember-/u, "")}` };
}

/** Compound remember dialog (spec §5.1): per-piece first-token glob checklist with live YAML preview. */
export async function rememberCompound(
	ui: ExtensionUIContext,
	pendingPieces: PieceEvaluation[],
	action: "allow" | "deny",
	ctx: EngineContext,
): Promise<Omit<PermissionRule, "layer"> | typeof SCOPE_BACK | undefined> {
	const toRule = (piece: PieceEvaluation): CandidateRule => {
		const pattern = firstTokenPattern(piece.text);
		return candidate("bash", action, "pattern", { command: pattern }, `${pattern}`);
	};
	const buildOptions = (pieces: PieceEvaluation[]): PermissionDialogOption[] => {
		const options: PermissionDialogOption[] = pieces.map(piece => {
			const rule = toRule(piece);
			return {
				label: rule.rule.match.command as string,
				description: piece.text,
				checked: true,
				toggleable: true,
			};
		});
		options.push({
			label: `Write checked ${action === "allow" ? "allow" : "deny"} rules (${pieces.length})`,
			labelFor: checked =>
				`Write checked ${action === "allow" ? "allow" : "deny"} rules (${checked.filter(Boolean).length})`,
		});
		return options;
	};
	const previewFor = (checked: boolean[]): string =>
		checked
			.map((on, index) => (on ? renderCandidateYaml(toRule(pendingPieces[index]!).rule) : ""))
			.filter(Boolean)
			.join("\n");

	const request: PermissionDialogRequest = {
		title: `Remember ${action === "allow" ? "allow" : "deny"} — what rule?`,
		lines: [
			{
				segments: [{ text: `${pendingPieces.length} pending pieces — an exact match would never fire again, so:` }],
				style: "muted",
			},
			{
				segments: [{ text: "[x] rows are written as rules; uncheck the ones you don't want" }],
				style: "muted",
			},
		],
		options: buildOptions(pendingPieces),
		checklist: true,
		allowEdit: true,
		previewFor,
		helpText: "j/k navigate  space/enter toggle  enter write checked  esc back",
		// The write button is preselected: all rows start checked, so Enter
		// writes immediately (spec §5.1). Row = pieces.length (last option).
		initialIndex: pendingPieces.length,
	};
	const index = await ui.showPermissionDialog?.(request);
	if (index === -1 || index === undefined) return SCOPE_BACK; // esc — back to the compound decision page
	if (index < -1) {
		// e: edit the selected piece's glob, then write the edited rule directly.
		const pieceIndex = -index - 2;
		const piece = pendingPieces[pieceIndex];
		if (piece === undefined || ui.input === undefined) return undefined;
		const current = toRule(piece).rule.match.command as string;
		const edited = await ui.input(`Edit glob for ${piece.text}`, current);
		if (edited === undefined || edited.trim().length === 0) return undefined;
		const rule = candidate("bash", action, "pattern", { command: edited.trim() }, edited.trim());
		await writeRememberedRule(rule.rule, ctx);
		return rule.rule;
	}
	const picked = request.options[index];
	if (picked === undefined || picked.labelFor === undefined) return undefined; // piece row picked — no write
	// The component wrote checked state back onto the request's option objects
	// (Task 4 Step 4), so read the final state from the request.
	const written: Array<Omit<PermissionRule, "layer">> = [];
	for (const option of request.options) {
		if (option.toggleable === true && option.checked === true) {
			written.push(candidate("bash", action, "pattern", { command: option.label }, option.label).rule);
		}
	}
	if (written.length === 0) return undefined;
	for (const rule of written) await writeRememberedRule(rule, ctx);
	return written[0];
}

/** Per-piece drill-down (spec §5.1): pick a pending piece, decide it, repeat; Back leaves the rest denied. */
async function drillDownPieces(
	ui: ExtensionUIContext,
	pendingPieces: PieceEvaluation[],
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
): Promise<PromptResolution> {
	const BACK_TO_ALL_PIECES = "Back to all pieces";
	let remembered: Omit<PermissionRule, "layer"> | undefined;
	const remaining = [...pendingPieces];
	while (remaining.length > 0) {
		const picked = await chooseLabel(ui, "Decide per piece", ["Back", ...remaining.map(piece => piece.text)]);
		if (picked === undefined || picked === "Back") break; // cancel — undecided pieces stay denied
		const index = remaining.findIndex(piece => piece.text === picked);
		if (index < 0) break;
		const [piece] = remaining.splice(index, 1);
		const resolution = await promptUnit(
			ui,
			"bash",
			{ command: piece.text },
			decision,
			ctx,
			opts,
			[piece],
			BACK_TO_ALL_PIECES,
		);
		if (resolution.policy === "back") {
			// Back to all pieces: return the piece to the selector, undecided.
			remaining.splice(index, 0, piece);
			continue;
		}
		if (resolution.policy === "deny") {
			// fail closed: a denied piece denies the whole call, carrying any
			// rule remembered for it
			return resolution.remembered !== undefined
				? { policy: "deny", remembered: resolution.remembered }
				: { policy: "deny" };
		}
		if (resolution.remembered !== undefined) remembered = resolution.remembered;
	}
	if (remaining.length > 0) {
		// Back/esc left pieces undecided — cancel denies the whole call (§4.3).
		return { policy: "deny" };
	}
	return remembered !== undefined ? { policy: "allow", remembered } : { policy: "allow" };
}

/**
 * Resolve a pending engine decision through the approval dialog.
 *
 * Bash calls with more than one piece show ONE compound dialog for the whole
 * call (spec §5.1): allow/deny all pending at once, remember a rule for all
 * pending pieces, or drill down per piece. PTY calls, non-bash calls, forced
 * prompts, and single-piece calls keep the single-unit flow (`promptUnit`).
 * Any cancel (`select`/dialog → undefined) denies. Denying any unit denies the
 * call.
 */
export async function promptForDecision(
	ui: ExtensionUIContext,
	toolName: string,
	args: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions = {},
): Promise<PromptResolution> {
	const ptyCall = isPtyCall(args);

	let pieces = decision.pieces;
	if (pieces === undefined && toolName === "bash" && !ptyCall) {
		const command = argString(args, "command");
		if (command !== undefined) {
			pieces = evaluateBashCommand(command, ctx).pieces;
		}
	}
	const pendingPieces = (pieces ?? []).filter(piece => piece.policy === "prompt");

	// Every piece is already decided — nothing to prompt for. Only bash
	// decisions carry pieces; non-bash tools (pieces undefined) must still
	// dialog below.
	if (pieces !== undefined && pendingPieces.length === 0) {
		return { policy: "allow" };
	}

	// Single-unit flows: PTY, non-bash, forced prompts, or one piece.
	if (ptyCall || opts.includeCandidates === false || pieces === undefined || pieces.length <= 1) {
		return promptUnit(ui, toolName, args, decision, ctx, opts, pieces);
	}

	// v3 compound flow: one dialog for the whole call (spec §5.1).
	const title = opts.title ?? defaultTitle(toolName);
	const metaLines = dialogMetadataLines(toolName, opts);
	const lines = [...metaLines, ...buildDialogLines(decision, pieces, ctx)];
	const suggestionFlow =
		opts.suggestionsProvider !== undefined
			? opts
					.suggestionsProvider(unitPieceText(toolName, args))
					.then(resolved => resolveSuggestions(resolved, toolName, args, pendingPieces))
					.catch(() => EMPTY_SUGGESTIONS)
			: undefined;
	const rememberDisabled = pendingPieces.some(piece => bashRememberDisabled({ command: piece.text }));
	const baseOptions = rememberDisabled
		? [ALLOW_ALL_ONCE, DENY_ALL]
		: [ALLOW_ALL_ONCE, ALLOW_ALL_SESSION, ALLOW_ALL_REMEMBER, DENY_ALL, DRILL_DOWN];
	// The model's recommendation preselects the compound option when it
	// lands; until then no selection. Esc on the remember checklist returns
	// here.
	const preselect = suggestionFlow?.then(resolved =>
		compoundRecommendationIndex(resolved.result.recommendation, baseOptions),
	);
	while (true) {
		const chosen = await chooseLabel(
			ui,
			dialogTitle(ui, title, metaLines),
			baseOptions,
			lines,
			suggestionFlow?.then(result => result.options),
			{ ...(preselect !== undefined ? { preselect } : {}) },
		);
		switch (chosen) {
			case ALLOW_ALL_ONCE:
				return { policy: "allow" };
			case DENY_ALL:
				return { policy: "deny" };
			case ALLOW_ALL_SESSION: {
				// One in-memory session rule per pending piece (first-token
				// globs), mirroring the remember checklist without any disk
				// write.
				for (const piece of pendingPieces) {
					const rule = candidate(
						"bash",
						"allow",
						"pattern",
						{ command: firstTokenPattern(piece.text) },
						firstTokenPattern(piece.text),
					).rule;
					addSessionRule(sessionRuleKey(ctx), sessionRule(rule));
				}
				return { policy: "allow" };
			}
			case ALLOW_ALL_REMEMBER: {
				const rule = await rememberCompound(ui, pendingPieces, "allow", ctx);
				if (rule === SCOPE_BACK) continue; // back to the compound decision page
				return rule === undefined ? { policy: "deny" } : { policy: "allow", remembered: rule };
			}
			case DRILL_DOWN:
				return drillDownPieces(ui, pendingPieces, decision, ctx, opts);
			default:
				// Suggestion option picked from the dialog (appended options).
				if (chosen !== undefined && suggestionFlow !== undefined) {
					const picked = (await suggestionFlow).byLabel.get(chosen);
					if (picked !== undefined) {
						await writeRememberedRule(picked.rule, ctx);
						return { policy: picked.rule.action === "allow" ? "allow" : "deny", remembered: picked.rule };
					}
				}
				return { policy: "deny" };
		}
	}
}
