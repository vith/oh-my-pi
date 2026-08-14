/**
 * Model-decided approval choices (spec §5.3): a one-shot side completion on
 * the session's active model that proposes up to 3 choices for the approval
 * dialog, ordered by likely user desire. The first choice preselects the
 * dialog's action — auto-mode-with-confirmation — and the rest are offered
 * as alternative options (the extra options are gated by
 * `permissions.llmSuggestions`). Every failure path degrades silently to an
 * empty result, so the dialog's own candidates always remain the floor and a
 * failing suggestion simply leaves the dialog unpreselected.
 */
import { type Api, type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { EngineContext } from "./engine";
import suggestionSystemPrompt from "./suggest.prompt.md" with { type: "text" };

/** One complete dialog option: what to do with the call, in the user's likely order of desire. */
export interface SuggestionChoice {
	action: "allow" | "deny";
	/**
	 * Save a rule so this call never prompts again. `false` = run once
	 * without remembering. The pattern-vs-exact decision is separate: when
	 * remembering, include `pattern` to cover a family, omit it to remember
	 * the exact call.
	 */
	remember: boolean;
	/** The glob when remembering a family: command glob for bash, path glob for file tools. */
	pattern?: string;
	/** One short line: why this choice. */
	reason?: string;
}

/** The full provider outcome: an ordered list of choices; the first preselects. */
export interface SuggestResult {
	choices: SuggestionChoice[];
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

/** Side requests are bounded: hard timeout, capped token budget, at most 3 choices. */
const SUGGEST_TIMEOUT_MS = 30000;
// Reasoning models (e.g. opencode-go deepseek-v4-flash) spend most of the
// budget thinking before emitting the JSON; 256 tokens was entirely consumed
// by reasoning (stopReason "length", zero text) so no choice ever landed.
// 2048 leaves room for ~1k reasoning tokens plus the response.
const SUGGEST_MAX_TOKENS = 2048;
const SUGGEST_MAX_CHOICES = 3;

const LLM_SUGGESTIONS_KEY = "permissions.llmSuggestions";

/** The extra-choice gate: `permissions.llmSuggestions` (defaults to off). The first choice always preselects. */
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

const EMPTY_RESULT: SuggestResult = { choices: [] };

/**
 * Fire the one-shot choice completion for a pending call.
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

		const requestStartedAt = performance.now();
		const userMessage = buildSuggestionPrompt(unit, ctx);
		logger.debug("permission-suggest: request", {
			pendingCall: unit.text,
			model: `${model.provider}/${model.id}`,
			maxTokens: SUGGEST_MAX_TOKENS,
			timeoutMs: SUGGEST_TIMEOUT_MS,
			reasoning:
				model.api.startsWith("openai-") || model.api.startsWith("azure-openai-") ? Effort.Minimal : undefined,
			systemPrompt: suggestionSystemPrompt,
			userMessage,
		});

		const response = await completeSimple(
			model,
			{
				systemPrompt: [suggestionSystemPrompt],
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens: SUGGEST_MAX_TOKENS,
				// OpenAI-compat gateways (e.g. opencode-go's Zen) default
				// thinking ON when the effort field is omitted, and unbounded
				// thinking can consume the whole token budget before the JSON
				// arrives (issue 14: 256 tokens were all reasoning). Pin the
				// lowest effort so the model still reasons — its judgment is
				// the point of the side request — but with a bounded thinking
				// budget. Other APIs (anthropic, google, bedrock) only think
				// when explicitly requested, so nothing to pin there.
				...(model.api.startsWith("openai-") || model.api.startsWith("azure-openai-")
					? { reasoning: Effort.Minimal }
					: {}),
				signal: requestSignal,
			},
		);

		// Full wire view for debugging the recommendation (input logged at
		// request time): stop reason, usage, and every content block —
		// including the thinking trace — verbatim.
		logger.debug("permission-suggest: response", {
			pendingCall: unit.text,
			model: `${model.provider}/${model.id}`,
			stopReason: response.stopReason,
			errorMessage: response.errorMessage ?? undefined,
			elapsedMs: Math.round(performance.now() - requestStartedAt),
			usage: (response as { usage?: unknown }).usage,
			content: response.content.map(block => {
				switch (block.type) {
					case "text":
						return { type: block.type, text: block.text };
					case "thinking":
						return { type: block.type, thinking: block.thinking };
					case "redactedThinking":
						return { type: block.type, data: block.data };
					default:
						return { type: block.type };
				}
			}),
		});

		if (response.stopReason === "aborted") {
			// The hard timeout or the caller's signal cut the request before
			// the provider produced a result (observed: 20s, zero tokens on a
			// compound call — gateway start latency). Distinct from bad-json
			// so timeouts are diagnosable at a glance.
			logger.debug("permission-suggest: suggestion request aborted", {
				reason: "request-aborted",
				pendingCall: unit.text,
				elapsedMs: Math.round(performance.now() - requestStartedAt),
			});
			return EMPTY_RESULT;
		}

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
		return parseSuggestResponse(response.content, suggestionsEnabled(ctx), response.stopReason);
	} catch (error) {
		logger.debug("permission-suggest: suggestion request failed", {
			reason: "request-failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return EMPTY_RESULT;
	}
}

/**
 * The user message: the pending call (tool + args) and the cwd. No rule
 * context — a prompt only fires when no existing rule matched, so there is
 * nothing to avoid duplicating.
 */
function buildSuggestionPrompt(unit: SuggestionUnit, ctx: EngineContext): string {
	const lines = [
		`Pending call: ${unit.text}`,
		`Tool: ${unit.tool}`,
		`Arguments: ${JSON.stringify(unit.args)}`,
		`Cwd: ${ctx.cwd}`,
	];
	// The extra choices are gated; the first choice (the preselection) always runs.
	if (!suggestionsEnabled(ctx)) lines.push("Provide exactly one choice.");
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one model choice; malformed → undefined. */
function parseChoice(value: unknown): SuggestionChoice | undefined {
	if (!isRecord(value)) return undefined;
	const action = value.action;
	if (action !== "allow" && action !== "deny") return undefined;
	if (typeof value.remember !== "boolean") return undefined;
	const choice: SuggestionChoice = { action, remember: value.remember };
	if (typeof value.pattern === "string" && value.pattern.length > 0) choice.pattern = value.pattern;
	if (typeof value.reason === "string" && value.reason.length > 0) choice.reason = value.reason;
	return choice;
}

/**
 * Parse the model's JSON object: `{ choices: [...] }`, validating each record
 * and capping the list at 3. Without `includeExtraChoices` (the
 * `permissions.llmSuggestions` gate) only the first choice is kept — it is
 * the preselection; the rest are extra dialog options. Malformed output
 * degrades to an empty result.
 */
function parseSuggestResponse(
	content: AssistantMessage["content"],
	includeExtraChoices: boolean,
	stopReason: string | undefined,
): SuggestResult {
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
			stopReason,
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
	if (!Array.isArray(parsed.choices)) {
		logger.debug("permission-suggest: model response carries no choices array", {
			reason: "no-choices",
			text: jsonText.slice(0, 200),
		});
		return EMPTY_RESULT;
	}

	const result: SuggestResult = { choices: [] };
	for (const record of parsed.choices) {
		if (result.choices.length >= SUGGEST_MAX_CHOICES) break;
		const choice = parseChoice(record);
		if (choice !== undefined) {
			result.choices.push(choice);
		} else {
			logger.debug("permission-suggest: malformed choice in model response", {
				reason: "bad-choice",
				choice: JSON.stringify(record).slice(0, 200),
			});
		}
	}
	if (!includeExtraChoices && result.choices.length > 1) result.choices = result.choices.slice(0, 1);
	return result;
}
