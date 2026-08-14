/**
 * Model-decided approval recommendation (spec §5.3): a one-shot side
 * completion on the session's active model that (a) recommends which action
 * the approval dialog should preselect — auto-mode-with-confirmation — and
 * (b) optionally proposes allow/deny rules appended to the dialog as extra
 * options. The recommendation always runs; the rule suggestions are gated by
 * `permissions.llmSuggestions`. Every failure path degrades silently to an
 * empty result, so the mechanical candidates always remain the floor and a
 * failing recommendation simply leaves the dialog unpreselected.
 */
import { type Api, type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { CURATED_ALLOW_TOOLS } from "./curated";
import type { EngineContext } from "./engine";
import { loadRuleLayers, normalizeRule, type PermissionRule } from "./rules";
import suggestionSystemPrompt from "./suggest.prompt.md" with { type: "text" };

/** One LLM-proposed rule plus the model's stated rationale for it. */
export interface Suggestion {
	rule: Omit<PermissionRule, "layer">;
	rationale: string;
}

/** The remember scopes a recommendation can target; `once` = no rule. */
export type RecommendationScope = "once" | "exact" | "pattern" | "tool";

/** The model's recommended action for a pending call — what gets preselected. */
export interface Recommendation {
	action: "allow" | "deny";
	scope: RecommendationScope;
	reason?: string;
}

/** The full provider outcome: the recommendation plus any proposed rules. */
export interface SuggestResult {
	suggestions: Suggestion[];
	recommendation?: Recommendation;
}

/** One prompt unit handed to the provider: the tool, its raw args, and display text. */
export interface SuggestionUnit {
	/** Tool name, e.g. "bash", "read", "write". */
	tool: string;
	/** The tool call arguments (the raw record, unnormalized). */
	args: unknown;
	/** Display text: the command for bash, else `tool <json-args>`. */
	text: string;
}

export type SuggestionProvider = (unit: SuggestionUnit) => Promise<SuggestResult>;

/** Side requests are bounded: 8s hard timeout, low token budget, at most 3 rules. */
const SUGGEST_TIMEOUT_MS = 8000;
const SUGGEST_MAX_TOKENS = 256;
const SUGGEST_MAX_SUGGESTIONS = 3;

const LLM_SUGGESTIONS_KEY = "permissions.llmSuggestions";

/** The rule-suggestion gate: `permissions.llmSuggestions` (defaults to off). Rules only — the recommendation always runs. */
function suggestionsEnabled(ctx: EngineContext): boolean {
	return ctx.settings.get(LLM_SUGGESTIONS_KEY) !== false;
}

/**
 * Fallback model resolution for callers without a session-model handle: the
 * first available (authenticated) model. The wrapper path binds the session's
 * active model explicitly via {@link createSuggestionProvider}.
 */
function resolveSuggestionModel(registry: ModelRegistry): Model<Api> | undefined {
	return registry.getAvailable()[0];
}

const EMPTY_RESULT: SuggestResult = { suggestions: [] };

/**
 * Fire the one-shot recommendation completion for a pending call.
 *
 * Any failure — no model, no API key, provider error, timeout, abort, or
 * unparseable output — degrades to an empty result (silently; debug-logged
 * only), leaving the dialog without a preselection.
 */
export async function suggestRules(
	unit: SuggestionUnit,
	ctx: EngineContext,
	registry: ModelRegistry,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<SuggestResult> {
	try {
		const model = resolveSuggestionModel(registry);
		if (!model) return EMPTY_RESULT;
		return await suggestWithModel(unit, model, ctx, registry, sessionId, signal);
	} catch (error) {
		logger.debug("permission-suggest: suggestion request failed", {
			reason: "unexpected-failure",
			error: error instanceof Error ? error.message : String(error),
		});
		return EMPTY_RESULT;
	}
}

/**
 * Build a suggestions provider bound to a session: the wrapper (which has the
 * session's active model on the tool context) creates one per approval gate
 * and hands it to `promptForDecision`. The gate and all failure degradation
 * live here, so callers never see a throwing provider.
 */
export function createSuggestionProvider(
	ctx: EngineContext,
	registry: ModelRegistry,
	sessionId?: string,
	model?: Model<Api>,
	signal?: AbortSignal,
): SuggestionProvider {
	const resolvedModel = model ?? resolveSuggestionModel(registry);
	if (!resolvedModel) return () => Promise.resolve(EMPTY_RESULT);
	return unit => suggestWithModel(unit, resolvedModel, ctx, registry, sessionId, signal);
}

async function suggestWithModel(
	unit: SuggestionUnit,
	model: Model<Api>,
	ctx: EngineContext,
	registry: ModelRegistry,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<SuggestResult> {
	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) return EMPTY_RESULT;

		// The side request must never outlive the dialog: the caller's signal
		// (session teardown, dialog dismissal) and the hard timeout race.
		const requestSignal =
			signal !== undefined
				? AbortSignal.any([AbortSignal.timeout(SUGGEST_TIMEOUT_MS), signal])
				: AbortSignal.timeout(SUGGEST_TIMEOUT_MS);

		const response = await completeSimple(
			model,
			{
				systemPrompt: [suggestionSystemPrompt],
				messages: [{ role: "user", content: buildSuggestionPrompt(unit, ctx), timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens: SUGGEST_MAX_TOKENS,
				disableReasoning: true,
				signal: requestSignal,
			},
		);

		if (response.stopReason === "error") {
			// The provider rejected the side request (e.g. a sibling dialog's
			// suggestion already in flight). Visible at debug so a missing
			// preselection is diagnosable instead of silently empty.
			logger.debug("permission-suggest: suggestion request failed", {
				reason: "provider-error",
				error: response.errorMessage ?? "provider returned an error stop reason",
			});
			return EMPTY_RESULT;
		}
		return parseSuggestResponse(response.content, suggestionsEnabled(ctx));
	} catch (error) {
		logger.debug("permission-suggest: suggestion request failed", {
			reason: "request-failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return EMPTY_RESULT;
	}
}

/**
 * The user message: the pending call (tool + args), the cwd, a summary of
 * current rules, and the mechanical candidates the dialog would offer on its
 * own — so the model aims above them instead of duplicating them.
 */
function buildSuggestionPrompt(unit: SuggestionUnit, ctx: EngineContext): string {
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	const lines = [
		`Pending call: ${unit.text}`,
		`Tool: ${unit.tool}`,
		`Arguments: ${JSON.stringify(unit.args)}`,
		`Cwd: ${ctx.cwd}`,
	];
	if (rules.length > 0) {
		lines.push("Current rules:");
		for (const rule of rules) {
			lines.push(`- ${rule.tool} ${JSON.stringify(rule.match)} -> ${rule.action}`);
		}
	}
	const candidates = mechanicalCandidates(unit);
	if (candidates.length > 0) {
		lines.push("Mechanical candidates (already offered — do not duplicate them):");
		for (const candidate of candidates) lines.push(`- ${candidate}`);
	}
	// Rule suggestions are gated; the recommendation always runs.
	if (!suggestionsEnabled(ctx)) lines.push("Do not include a rules array in your response.");
	return lines.join("\n");
}

/** The deterministic candidate shapes the dialog offers without the model. */
function mechanicalCandidates(unit: SuggestionUnit): string[] {
	if (unit.tool === "bash") {
		const command = isRecord(unit.args) && typeof unit.args.command === "string" ? unit.args.command : unit.text;
		const firstToken = command.trim().split(/\s+/u)[0];
		return firstToken !== undefined ? [`Exact: ${command}`, `Pattern: ${firstToken} *`] : [`Exact: ${command}`];
	}
	if (isRecord(unit.args) && typeof unit.args.path === "string") {
		const fileArg = unit.args.path;
		const parent = fileArg.includes("/") ? fileArg.slice(0, fileArg.lastIndexOf("/")) : ".";
		const glob = parent === "." ? "./**" : `${parent}/**`;
		return [`Exact: ${fileArg}`, `Pattern: ${glob}`];
	}
	return [`Exact: ${JSON.stringify(unit.args)}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the model's `recommendation` object; malformed → undefined. */
function parseRecommendation(value: unknown): Recommendation | undefined {
	if (!isRecord(value)) return undefined;
	const action = value.action;
	if (action !== "allow" && action !== "deny") return undefined;
	const scope = value.scope;
	if (scope !== "once" && scope !== "exact" && scope !== "pattern" && scope !== "tool") return undefined;
	const recommendation: Recommendation = { action, scope };
	if (typeof value.reason === "string" && value.reason.length > 0) recommendation.reason = value.reason;
	return recommendation;
}

/**
 * Parse the model's JSON object: `{ recommendation?, rules? }`, validating
 * each record and capping rules at 3. Malformed output degrades to an empty
 * result.
 */
function parseSuggestResponse(content: AssistantMessage["content"], includeRules: boolean): SuggestResult {
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	const jsonText = text
		.trim()
		.replace(/^```(?:json)?\s*/u, "")
		.replace(/\s*```$/u, "");

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		logger.debug("permission-suggest: suggestion response is not valid JSON", {
			reason: "bad-json",
			text: jsonText.slice(0, 200),
		});
		return EMPTY_RESULT;
	}
	if (!isRecord(parsed)) {
		logger.debug("permission-suggest: suggestion response is not an object", {
			reason: "bad-shape",
			text: jsonText.slice(0, 200),
		});
		return EMPTY_RESULT;
	}

	const result: SuggestResult = { suggestions: [] };
	const recommendation = parseRecommendation(parsed.recommendation);
	if (recommendation !== undefined) {
		result.recommendation = recommendation;
	} else if (parsed.recommendation !== undefined) {
		logger.debug("permission-suggest: malformed recommendation in model response", {
			reason: "bad-recommendation",
			recommendation: JSON.stringify(parsed.recommendation).slice(0, 200),
		});
	} else {
		logger.debug("permission-suggest: model response carries no recommendation", { reason: "no-recommendation" });
	}
	if (!includeRules || !Array.isArray(parsed.rules)) return result;

	for (const record of parsed.rules) {
		if (result.suggestions.length >= SUGGEST_MAX_SUGGESTIONS) break;
		const rule = normalizeRule(record, "user");
		if (rule === null) continue;
		// Read-only tools are curated-allowlisted; a deny suggestion for one can
		// never take effect and only confuses the user.
		if (rule.action === "deny" && (CURATED_ALLOW_TOOLS as readonly string[]).includes(rule.tool)) continue;
		// bash has no tool-wide scope in the dialog (the yolo knob is
		// hand-edited only): a tool-wide allow suggestion would append an
		// option that silently allows every future command. Denies of the
		// same shape stay — they are a legitimate defensive policy.
		if (rule.action === "allow" && rule.tool === "bash" && rule.match.command === "*") continue;
		result.suggestions.push({ rule: withoutLayer(rule), rationale: rule.reason ?? "" });
	}
	return result;
}

function withoutLayer(rule: PermissionRule): Omit<PermissionRule, "layer"> {
	const stripped: Omit<PermissionRule, "layer"> = {
		id: rule.id,
		tool: rule.tool,
		match: rule.match,
		action: rule.action,
	};
	if (rule.reason !== undefined) stripped.reason = rule.reason;
	if (rule.ttl !== undefined) stripped.ttl = rule.ttl;
	return stripped;
}
