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
 * choice of candidate rules (exact, pattern, tool-wide) that preview the exact
 * YAML they write. Remembering writes a dynamic rule (`writeDynamicRule` into
 * the dynamic layer file).
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
import { isSafeConsumerStage } from "./curated";
import {
	type EngineContext,
	type EngineDecision,
	evaluateBashCommand,
	hasBashApprovalShellControl,
	nearMissLine,
	type PieceEvaluation,
} from "./engine";
import { type PermissionRule, type RuleAction, ruleFiles, writeDynamicRule } from "./rules";
import { extractSubCommands } from "./split";
import type { Suggestion } from "./suggest";

/** A selectable rule candidate: the label the user sees, the YAML preview, and the rule to write. */
export interface CandidateRule {
	label: string;
	yaml: string;
	rule: Omit<PermissionRule, "layer">;
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
	 * When false the dialog offers only Approve/Deny with no candidates and no
	 * remember options (provider safety-check forced prompts).
	 */
	includeCandidates?: boolean;
	/**
	 * Task 11 (§5.3): optional LLM rule-suggestion provider. Per pending unit
	 * the flow fires it while the dialog is shown; suggestions append as extra
	 * options behind the dialog's spinner. Any provider failure degrades to
	 * candidates-only. Never called for forced prompts (`includeCandidates: false`).
	 */
	suggestionsProvider?: (piece: string) => Promise<Suggestion[]>;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_REMEMBER = "Allow & remember…";
const DENY = "Deny";
const DENY_REMEMBER = "Deny & remember…";
const APPROVE = "Approve";

/** v3 compound-dialog actions (spec §5.1): one dialog for the whole call. */
const ALLOW_ALL_ONCE = "Allow all pending once";
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
 * Matches `writeDynamicRule`'s entry shape so `normalizeRule` round-trips it.
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
	return { label, yaml: renderCandidateYaml(rule), rule };
}

/** bash: exact command, first-token pattern (`git *`), tool-wide. */
function bashCandidates(toolName: string, command: string, action: RuleAction): CandidateRule[] {
	const firstToken = command.trim().split(/\s+/u)[0] ?? "";
	const pattern = `${firstToken} *`;
	const deny = action === "deny";
	return [
		candidate(toolName, action, "exact", { command }, `${deny ? "Deny exact" : "Exact"}: ${command}`),
		candidate(toolName, action, "pattern", { command: pattern }, `${deny ? "Deny pattern" : "Pattern"}: ${pattern}`),
		candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
	];
}

/** file tools: exact path, parent-dir glob (`src/**`), tool-wide. */
function fileCandidates(toolName: string, key: string, fileArg: string, action: RuleAction): CandidateRule[] {
	const parent = path.dirname(fileArg);
	const glob = parent === "." ? "./**" : `${parent}/**`;
	const deny = action === "deny";
	return [
		candidate(toolName, action, "exact", { [key]: fileArg }, `${deny ? "Deny exact" : "Exact"}: ${fileArg}`),
		candidate(toolName, action, "pattern", { [key]: glob }, `${deny ? "Deny pattern" : "Pattern"}: ${glob}`),
		candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
	];
}

/** others: exact args + tool-wide. */
function genericCandidates(toolName: string, args: unknown, action: RuleAction): CandidateRule[] {
	const exactArgs = stringEntries(args);
	const deny = action === "deny";
	const candidates: CandidateRule[] = [];
	if (Object.keys(exactArgs).length > 0) {
		candidates.push(candidate(toolName, action, "exact", exactArgs, deny ? "Deny exact call" : "Exact call"));
	}
	candidates.push(
		candidate(toolName, action, "tool", { arg: "*" }, `${deny ? "Deny tool" : "Tool"}: ${toolName} always`),
	);
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
 * The model-visible allow suggestion for a denied call (spec §5.2): the exact
 * YAML of the first allow candidate, so the model can negotiate in chat.
 * Shell-control bash commands have no allow candidates — no rule can suppress
 * their prompt — so the suggestion says so instead of emitting a broken rule.
 */
export function renderAllowSuggestion(toolName: string, args: unknown): string {
	const first = buildCandidates(toolName, args)[0];
	if (first === undefined) {
		return "No rule can allow this call: the command uses shell control, which no remembered allow rule can suppress.";
	}
	return `To allow this call, add rule:\n${first.yaml}`;
}

function defaultTitle(toolName: string, decision: EngineDecision): string {
	const lines = [`Allow tool: ${toolName}`];
	if (decision.reason !== undefined) lines.push(`Reason: ${decision.reason}`);
	return lines.join("\n");
}

function pieceStatusText(piece: PieceEvaluation): { text: string; style?: "muted" | "text" | "accent" } {
	if (piece.policy === "allow") {
		if (piece.ruleId === undefined) return { text: "allowed" };
		return piece.layer === "dynamic"
			? { text: "allowed · remembered this session", style: "muted" }
			: { text: `allowed · ${piece.layer ?? "rule"} rule ${piece.ruleId}`, style: "muted" };
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

/** Shape the provider result for both the dialog options and label routing. */
function resolveSuggestions(suggestions: Suggestion[]): {
	options: PermissionDialogOption[];
	byLabel: Map<string, Suggestion>;
} {
	const seen = new Set<string>();
	const options: PermissionDialogOption[] = [];
	const byLabel = new Map<string, Suggestion>();
	for (const suggestion of suggestions) {
		const label = suggestionLabel(suggestion);
		if (seen.has(label)) continue; // duplicate labels would be unroutable
		seen.add(label);
		options.push({ label, description: renderCandidateYaml(suggestion.rule) });
		byLabel.set(label, suggestion);
	}
	return { options, byLabel };
}

/** Present an option list, mapping the choice back to its label. Cancel → undefined. */
async function chooseLabel(
	ui: ExtensionUIContext,
	title: string,
	options: string[],
	lines?: readonly (string | PermissionDialogLine)[],
	suggestions?: Promise<PermissionDialogOption[]>,
): Promise<string | undefined> {
	if (ui.showPermissionDialog) {
		const request: PermissionDialogRequest = {
			title,
			...((lines?.length ?? 0) > 0 ? { lines } : {}),
			options: options.map(label => ({ label })),
			...(suggestions !== undefined ? { suggestions } : {}),
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

/** Level-2 scope choice: pick one candidate (with its YAML preview) or cancel. */
async function chooseCandidate(
	ui: ExtensionUIContext,
	title: string,
	candidates: CandidateRule[],
): Promise<CandidateRule | undefined> {
	if (candidates.length === 0) return undefined;
	if (ui.showPermissionDialog) {
		const request: PermissionDialogRequest = {
			title,
			options: candidates.map(candidateItem => ({ label: candidateItem.label, description: candidateItem.yaml })),
		};
		const index = await ui.showPermissionDialog(request);
		return index === undefined ? undefined : candidates[index];
	}
	const label = await ui.select(
		title,
		candidates.map(candidateItem => candidateItem.label),
	);
	if (label === undefined) return undefined;
	const index = candidates.findIndex(candidateItem => candidateItem.label === label);
	return index >= 0 ? candidates[index] : undefined;
}

async function writeRememberedRule(rule: Omit<PermissionRule, "layer">, ctx: EngineContext): Promise<void> {
	await writeDynamicRule(ruleFiles(ctx.cwd, ctx.home).dynamic, { ...rule, layer: "dynamic" });
}

/** Prompt for one unit (a pending bash piece, the whole call, or a whole PTY command). */
async function promptUnit(
	ui: ExtensionUIContext,
	toolName: string,
	unitArgs: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
	pieces: PieceEvaluation[] | undefined,
): Promise<PromptResolution> {
	const title = opts.title ?? defaultTitle(toolName, decision);

	if (opts.includeCandidates === false) {
		// Provider safety-check forced prompt: no candidates, binary choice only.
		const chosen = await chooseLabel(ui, title, [APPROVE, DENY], buildDialogLines(decision, pieces, ctx));
		const approved = chosen === APPROVE || chosen === ALLOW_ONCE;
		return { policy: approved ? "allow" : "deny" };
	}

	const candidates = buildCandidates(toolName, unitArgs, pieces);
	// The forced-prompt branch above already returned, so only candidate
	// dialogs reach here; the provider fires once per pending unit.
	const suggestionsPromise =
		opts.suggestionsProvider !== undefined
			? opts
					.suggestionsProvider(unitPieceText(toolName, unitArgs))
					.then(resolveSuggestions)
					.catch(() => ({ options: [], byLabel: new Map<string, Suggestion>() }))
			: undefined;
	// Shell-control bash commands cannot be suppressed by a remembered rule:
	// drop both remember options and say why.
	const rememberDisabled = bashRememberDisabled(unitArgs);
	const lines: (string | PermissionDialogLine)[] = buildDialogLines(decision, pieces, ctx);
	if (rememberDisabled) lines.push("", BASH_SHELL_CONTROL_NOTE);
	const chosen = await chooseLabel(
		ui,
		title,
		rememberDisabled ? [ALLOW_ONCE, DENY] : [ALLOW_ONCE, ALLOW_REMEMBER, DENY, DENY_REMEMBER],
		lines,
		suggestionsPromise?.then(result => result.options),
	);
	switch (chosen) {
		case ALLOW_ONCE:
		case LEGACY_APPROVE: // pre-dialog fake UI / older callers
			return { policy: "allow" };
		case DENY:
			return { policy: "deny" };
		case ALLOW_REMEMBER: {
			const rule = await chooseCandidate(
				ui,
				`Remember an allow rule for ${toolName}`,
				candidates.filter(candidateItem => candidateItem.rule.action === "allow"),
			);
			if (rule === undefined) return { policy: "deny" }; // cancelled at scope level
			await writeRememberedRule(rule.rule, ctx);
			return { policy: "allow", remembered: rule.rule };
		}
		case DENY_REMEMBER: {
			const rule = await chooseCandidate(
				ui,
				`Remember a deny rule for ${toolName}`,
				candidates.filter(candidateItem => candidateItem.rule.action === "deny"),
			);
			if (rule === undefined) return { policy: "deny" }; // cancelled at scope level
			await writeRememberedRule(rule.rule, ctx);
			return { policy: "deny", remembered: rule.rule };
		}
		default: {
			// A suggestion option picked from the dialog: remember its rule and
			// resolve with its action. Unknown labels still fail closed.
			if (chosen !== undefined && suggestionsPromise !== undefined) {
				const picked = (await suggestionsPromise).byLabel.get(chosen);
				if (picked !== undefined) {
					await writeRememberedRule(picked.rule, ctx);
					return { policy: picked.rule.action === "allow" ? "allow" : "deny", remembered: picked.rule };
				}
			}
			return { policy: "deny" };
		}
	}
}

/**
 * Compound remember dialog (spec §5.1): per-piece first-token glob checklist.
 *
 * Task 5 ships a minimal working version (checklist with the write option, no
 * `e`-edit/`Custom…` rows) so the compound flow is testable end-to-end; Task 6
 * replaces it with the full dialog (edit sentinels, custom globs, preselected
 * write option).
 */
export async function rememberCompound(
	ui: ExtensionUIContext,
	pendingPieces: PieceEvaluation[],
	action: "allow" | "deny",
	ctx: EngineContext,
): Promise<Omit<PermissionRule, "layer"> | undefined> {
	const toRule = (piece: PieceEvaluation): CandidateRule => {
		const firstToken = piece.text.trim().split(/\s+/u)[0] ?? "";
		const pattern = `${firstToken} *`;
		return candidate("bash", action, "pattern", { command: pattern }, pattern);
	};
	const verb = action === "allow" ? "allow" : "deny";
	const options: PermissionDialogOption[] = pendingPieces.map(piece => {
		const rule = toRule(piece);
		return {
			label: rule.rule.match.command as string,
			description: piece.text,
			checked: true,
			toggleable: true,
		};
	});
	options.push({
		label: `Write checked ${verb} rules (${pendingPieces.length})`,
		labelFor: checked => `Write checked ${verb} rules (${checked.filter(Boolean).length})`,
	});
	const request: PermissionDialogRequest = {
		title: `Remember ${verb} — what rule?`,
		options,
		checklist: true,
	};
	const index = await ui.showPermissionDialog?.(request);
	if (index === undefined || index === -1) return undefined; // plain cancel
	const picked = request.options[index];
	if (picked === undefined || picked.labelFor === undefined) return undefined; // piece row — nothing to write
	const written: Array<Omit<PermissionRule, "layer">> = [];
	for (const [pieceIndex, option] of request.options.entries()) {
		if (option.checked && pieceIndex < pendingPieces.length) {
			const rule = toRule(pendingPieces[pieceIndex]!);
			await writeRememberedRule(rule.rule, ctx);
			written.push(rule.rule);
		}
	}
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
	let remembered: Omit<PermissionRule, "layer"> | undefined;
	const remaining = [...pendingPieces];
	while (remaining.length > 0) {
		const picked = await chooseLabel(ui, "Decide per piece", ["Back", ...remaining.map(piece => piece.text)]);
		if (picked === undefined || picked === "Back") break; // cancel — undecided pieces stay denied
		const index = remaining.findIndex(piece => piece.text === picked);
		if (index < 0) break;
		const [piece] = remaining.splice(index, 1);
		const resolution = await promptUnit(ui, "bash", { command: piece.text }, decision, ctx, opts, [piece]);
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

	// Every piece is already decided — nothing to prompt for.
	if (pendingPieces.length === 0) {
		return { policy: "allow" };
	}

	// Single-unit flows: PTY, non-bash, forced prompts, or one piece.
	if (ptyCall || opts.includeCandidates === false || pieces === undefined || pieces.length <= 1) {
		return promptUnit(ui, toolName, args, decision, ctx, opts, pieces);
	}

	// v3 compound flow: one dialog for the whole call (spec §5.1).
	const title = opts.title ?? defaultTitle(toolName, decision);
	const lines = buildDialogLines(decision, pieces, ctx);
	const suggestionsPromise =
		opts.suggestionsProvider !== undefined
			? opts
					.suggestionsProvider(unitPieceText(toolName, args))
					.then(resolveSuggestions)
					.catch(() => ({ options: [], byLabel: new Map<string, Suggestion>() }))
			: undefined;
	const rememberDisabled = pendingPieces.some(piece => bashRememberDisabled({ command: piece.text }));
	const baseOptions = rememberDisabled
		? [ALLOW_ALL_ONCE, DENY_ALL]
		: [ALLOW_ALL_ONCE, ALLOW_ALL_REMEMBER, DENY_ALL, DRILL_DOWN];
	const chosen = await chooseLabel(
		ui,
		title,
		baseOptions,
		lines,
		suggestionsPromise?.then(result => result.options),
	);
	switch (chosen) {
		case ALLOW_ALL_ONCE:
			return { policy: "allow" };
		case DENY_ALL:
			return { policy: "deny" };
		case ALLOW_ALL_REMEMBER: {
			const rule = await rememberCompound(ui, pendingPieces, "allow", ctx);
			return rule === undefined ? { policy: "deny" } : { policy: "allow", remembered: rule };
		}
		case DRILL_DOWN:
			return drillDownPieces(ui, pendingPieces, decision, ctx, opts);
		default:
			// Suggestion option picked from the dialog (appended options).
			if (chosen !== undefined && suggestionsPromise !== undefined) {
				const picked = (await suggestionsPromise).byLabel.get(chosen);
				if (picked !== undefined) {
					await writeRememberedRule(picked.rule, ctx);
					return { policy: picked.rule.action === "allow" ? "allow" : "deny", remembered: picked.rule };
				}
			}
			return { policy: "deny" };
	}
}
