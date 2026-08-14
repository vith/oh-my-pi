/**
 * LLM-suggested permission rules (spec §5.3): a one-shot, non-streaming side
 * completion on the session's active model that proposes allow/deny rules for
 * a pending call. The approval dialog shows these behind a spinner and appends
 * them as extra options; every failure path degrades silently to `[]` so the
 * mechanical candidates always remain the floor.
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

/** Side requests are bounded: 8s hard timeout, low token budget, at most 3 rules. */
const SUGGEST_TIMEOUT_MS = 8000;
const SUGGEST_MAX_TOKENS = 256;
const SUGGEST_MAX_SUGGESTIONS = 3;

const LLM_SUGGESTIONS_KEY = "permissions.llmSuggestions";

/** The feature gate: `permissions.llmSuggestions` defaults to true. */
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

/**
 * Fire the one-shot suggestion completion for a pending call.
 *
 * Any failure — no model, no API key, provider error, timeout, abort, or
 * unparseable output — degrades to `[]` (silently; debug-logged only).
 */
export async function suggestRules(
	piece: string,
	ctx: EngineContext,
	registry: ModelRegistry,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<Suggestion[]> {
	try {
		if (!suggestionsEnabled(ctx)) return [];
		const model = resolveSuggestionModel(registry);
		if (!model) return [];
		return await suggestWithModel(piece, model, ctx, registry, sessionId, signal);
	} catch (error) {
		logger.debug("permission-suggest: suggestion request failed", {
			reason: "unexpected-failure",
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
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
): (piece: string) => Promise<Suggestion[]> {
	if (!suggestionsEnabled(ctx)) return () => Promise.resolve([]);
	const resolvedModel = model ?? resolveSuggestionModel(registry);
	if (!resolvedModel) return () => Promise.resolve([]);
	return piece => suggestWithModel(piece, resolvedModel, ctx, registry, sessionId, signal);
}

async function suggestWithModel(
	piece: string,
	model: Model<Api>,
	ctx: EngineContext,
	registry: ModelRegistry,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<Suggestion[]> {
	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) return [];

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
				messages: [{ role: "user", content: buildSuggestionPrompt(piece, ctx), timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens: SUGGEST_MAX_TOKENS,
				disableReasoning: true,
				signal: requestSignal,
			},
		);

		if (response.stopReason === "error") return [];
		return parseSuggestionResponse(response.content);
	} catch (error) {
		logger.debug("permission-suggest: suggestion request failed", {
			reason: "request-failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/** The user message: the pending call, the cwd, and a summary of current rules. */
function buildSuggestionPrompt(piece: string, ctx: EngineContext): string {
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	const lines = [`Pending call: ${piece}`, `Cwd: ${ctx.cwd}`];
	if (rules.length > 0) {
		lines.push("Current rules:");
		for (const rule of rules) {
			lines.push(`- ${rule.tool} ${JSON.stringify(rule.match)} -> ${rule.action}`);
		}
	}
	return lines.join("\n");
}

/** Parse the model's JSON array, validating each record and capping at 3. */
function parseSuggestionResponse(content: AssistantMessage["content"]): Suggestion[] {
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
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const suggestions: Suggestion[] = [];
	for (const record of parsed) {
		if (suggestions.length >= SUGGEST_MAX_SUGGESTIONS) break;
		const rule = normalizeRule(record, "user");
		if (rule === null) continue;
		// Read-only tools are curated-allowlisted; a deny suggestion for one can
		// never take effect and only confuses the user.
		if (rule.action === "deny" && (CURATED_ALLOW_TOOLS as readonly string[]).includes(rule.tool)) continue;
		suggestions.push({ rule: withoutLayer(rule), rationale: rule.reason ?? "" });
	}
	return suggestions;
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
