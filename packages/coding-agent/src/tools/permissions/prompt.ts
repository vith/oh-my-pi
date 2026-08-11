/**
 * Approval prompt flow with rule candidates (spec §5).
 *
 * Replaces the binary Approve/Deny prompt: per pending piece (sequential, in
 * command order) the user picks from Allow once / Allow & remember… / Deny /
 * Deny & remember…, then a scope-level choice of candidate rules (exact,
 * pattern, tool-wide) that preview the exact YAML they write. Remembering
 * writes a dynamic rule (`writeDynamicRule` into the dynamic layer file).
 *
 * PTY calls (spec §4.3) cannot be execution-split: they prompt once for the
 * whole command, with candidates scoped to the whole command text.
 */
import * as path from "node:path";
import { YAML } from "bun";
import type {
	ExtensionUIContext,
	PermissionDialogOption,
	PermissionDialogRequest,
} from "../../extensibility/extensions/types";
import { type EngineContext, type EngineDecision, evaluateBashCommand, type PieceEvaluation } from "./engine";
import { type PermissionRule, type RuleAction, ruleFiles, writeDynamicRule } from "./rules";
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
 */
export function renderAllowSuggestion(toolName: string, args: unknown): string {
	const first = buildCandidates(toolName, args)[0];
	return `To allow this call, add rule:\n${first.yaml}`;
}

function defaultTitle(toolName: string, decision: EngineDecision): string {
	const lines = [`Allow tool: ${toolName}`];
	if (decision.reason !== undefined) lines.push(`Reason: ${decision.reason}`);
	return lines.join("\n");
}

function pieceStatus(piece: PieceEvaluation): string {
	switch (piece.policy) {
		case "allow":
			return "allowed";
		case "deny":
			return "denied";
		case "prompt":
			return "pending";
	}
}

function pieceStatusLine(piece: PieceEvaluation): string {
	const rule =
		piece.ruleId !== undefined ? ` (rule ${piece.ruleId}${piece.layer !== undefined ? `, ${piece.layer}` : ""})` : "";
	return `${piece.text} — ${pieceStatus(piece)}${rule}`;
}

/** Decision context + per-piece breakdown shown in the dialog. */
function dialogLines(decision: EngineDecision, pieces: PieceEvaluation[] | undefined): string[] {
	const lines: string[] = [];
	lines.push(
		decision.ruleId !== undefined
			? `Rule: ${decision.ruleId}${decision.layer !== undefined ? ` (${decision.layer})` : ""}`
			: "no rule — default posture",
	);
	if (decision.reason !== undefined) lines.push(`Reason: ${decision.reason}`);
	if (pieces !== undefined && pieces.length > 0) {
		lines.push("");
		for (const [index, piece] of pieces.entries()) {
			lines.push(`${index + 1}. ${pieceStatusLine(piece)}`);
		}
	}
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
	lines?: readonly string[],
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
		const chosen = await chooseLabel(ui, title, [APPROVE, DENY], dialogLines(decision, pieces));
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
	const chosen = await chooseLabel(
		ui,
		title,
		[ALLOW_ONCE, ALLOW_REMEMBER, DENY, DENY_REMEMBER],
		dialogLines(decision, pieces),
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
 * Resolve a pending engine decision through the approval dialog.
 *
 * Bash calls prompt per pending piece in command order (spec §4.3); the
 * pieces come from `decision.pieces`, recomputed through the engine when the
 * decision carries none. PTY calls and non-bash calls prompt once for the
 * whole call, with candidates scoped to the whole command text. Any cancel
 * (`select`/dialog → undefined) denies. Denying any unit denies the call.
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

	const units: unknown[] = [];
	if (ptyCall || pieces === undefined) {
		units.push(args);
	} else {
		for (const piece of pieces) {
			if (piece.policy === "prompt") {
				units.push(toolName === "bash" ? { command: piece.text } : args);
			}
		}
	}

	let remembered: Omit<PermissionRule, "layer"> | undefined;
	for (const unitArgs of units) {
		const resolution = await promptUnit(ui, toolName, unitArgs, decision, ctx, opts, pieces);
		if (resolution.policy === "deny") {
			return resolution.remembered !== undefined
				? { policy: "deny", remembered: resolution.remembered }
				: { policy: "deny" };
		}
		if (resolution.remembered !== undefined) remembered = resolution.remembered;
	}

	return remembered !== undefined ? { policy: "allow", remembered } : { policy: "allow" };
}
