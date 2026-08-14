import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { EngineContext } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	createSuggestionProvider,
	type SuggestionUnit,
	suggestRules,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/suggest";

/** A prompt unit matching what prompt.ts hands the provider. */
function unit(tool: string, args: Record<string, unknown>): SuggestionUnit {
	const text = tool === "bash" ? String(args.command) : `${tool} ${JSON.stringify(args)}`;
	return { tool, args, text };
}

const SUGGESTION_KEY = "permissions.llmSuggestions";

const fakeModel = { provider: "test", id: "suggester", api: "openai-completions" } as unknown as Model;

function fakeRegistry(model: Model | null = fakeModel): ModelRegistry {
	return {
		getAvailable: () => (model === null ? [] : [model]),
		getApiKey: async () => "test-key",
		resolver: () => () => "test-key",
	} as unknown as ModelRegistry;
}

function fakeCtx(overrides: { llmSuggestions?: boolean } = {}): EngineContext {
	return {
		settings: {
			get: (key: string) => (key === SUGGESTION_KEY ? overrides.llmSuggestions : undefined),
			isConfigured: () => false,
		} as unknown as EngineContext["settings"],
		cwd: "/tmp/suggest-proj",
		home: "/tmp/suggest-home",
	};
}

function assistantJson(text: string) {
	return { stopReason: "stop", content: [{ type: "text", text }] } as never;
}

const EMPTY_CHOICES = { choices: [] };
const RECOMMENDED_ALLOW_ONCE = { choices: [{ action: "allow" as const, remember: false }] };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("suggestRules", () => {
	it("parses the model's choices in order", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'{"choices":[{"action":"allow","remember":true,"pattern":"git push","reason":"safe push"},{"action":"deny","remember":true,"pattern":"git *","reason":"untrusted git"}]}',
			),
		);
		const result = await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		expect(result.choices).toHaveLength(2);
		expect(result.choices[0]).toEqual({
			action: "allow",
			remember: true,
			pattern: "git push",
			reason: "safe push",
		});
		expect(result.choices[1]?.action).toBe("deny");
	});

	it("caps choices at 3 even when the model returns more", async () => {
		const records = Array.from({ length: 6 }, (_, index) => ({
			action: "allow",
			remember: true,
			pattern: `cmd ${index}`,
		}));
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson(JSON.stringify({ choices: records })));
		const result = await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry());
		expect(result.choices).toHaveLength(3);
	});

	it("keeps valid choices and degrades malformed ones to none", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"choices":[{"action":"maybe","remember":true}]}'),
		);
		const result = await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry());
		expect(result.choices).toEqual([]);

		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"choices":[{"action":"allow","remember":"yes"}]}'),
		);
		expect((await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry())).choices).toEqual([]);

		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"choices":[{"action":"deny","remember":true,"pattern":"*","reason":"dangerous"}]}'),
		);
		expect((await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry())).choices).toEqual([
			{ action: "deny", remember: true, pattern: "*", reason: "dangerous" },
		]);
	});

	it("drops malformed records and keeps valid ones", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'{"choices":[{"action":"allow","remember":true,"pattern":"git push","reason":"ok"},{"action":"nope","remember":true},{"remember":"x"}]}',
			),
		);
		const result = await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		expect(result.choices).toHaveLength(1);
		expect(result.choices[0]?.action).toBe("allow");
	});

	it("degrades to an empty result when the response is not a JSON object", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("sure, just allow it"));
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(
			EMPTY_CHOICES,
		);
	});

	it("degrades to an empty result when the response carries no choices array", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"recommendation":{"action":"allow"}}'));
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(
			EMPTY_CHOICES,
		);
	});

	it("degrades to an empty result when completeSimple rejects", async () => {
		vi.spyOn(piAi, "completeSimple").mockRejectedValue(new Error("provider down"));
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(
			EMPTY_CHOICES,
		);
	});

	it("degrades to an empty result when the provider reports a stopReason of error", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "rate limited",
			content: [],
		} as never);
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(
			EMPTY_CHOICES,
		);
	});

	it("sends the imported system prompt with the call, cwd, and the ordered decision structure", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"choices":[]}'));
		await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry(), "session-1");
		const request = spy.mock.calls[0]?.[1] as { systemPrompt?: string[]; messages?: Array<{ content: string }> };
		expect(request?.systemPrompt).toBeDefined();
		const systemPrompt = request.systemPrompt?.join("\n") ?? "";
		expect(systemPrompt.length).toBeGreaterThan(0);
		expect(systemPrompt).toContain("policy assistant");
		// The engine's glob semantics must be spelled out: the model has no
		// way to know `*` crosses `/`, the separator token, or `~` expansion.
		expect(systemPrompt).toContain('"*" matches any run of characters INCLUDING "/"');
		expect(systemPrompt).toContain('the space before "*" is literal');
		expect(systemPrompt).toContain('A leading "~" in a path pattern');
		// The three decisions are made in order, and remembering is the
		// default for repeatable calls — the model must not dodge rules to
		// avoid duplicating the dialog's own candidates (issue 16).
		expect(systemPrompt.indexOf("1. Allow or deny?")).toBeLessThan(systemPrompt.indexOf("2. Remember it or not?"));
		expect(systemPrompt.indexOf("2. Remember it or not?")).toBeLessThan(
			systemPrompt.indexOf("3. If remembering: pattern or exact?"),
		);
		expect(systemPrompt).toContain("A human should not have to approve");
		// The dialog's own candidate shapes are UI, not prompt context — the
		// model must not be steered away from proposing them (issue 16).
		expect(systemPrompt).not.toContain("Mechanical");
		const userMessage = request.messages?.[0]?.content ?? "";
		expect(userMessage).toContain("git push");
		expect(userMessage).toContain("Tool: bash");
		expect(userMessage).toContain('Arguments: {"command":"git push"}');
		expect(userMessage).toContain("/tmp/suggest-proj");
		expect(userMessage).not.toContain("Mechanical candidates");
		expect(userMessage).not.toContain("- Exact:");
		expect(userMessage).not.toContain("- Pattern:");
		const options = spy.mock.calls[0]?.[2] as {
			apiKey?: unknown;
			maxTokens?: number;
			signal?: AbortSignal;
			reasoning?: string;
			disableReasoning?: boolean;
			forceReasoningOff?: boolean;
		};
		expect(options?.apiKey).toBeDefined();
		// Side requests stay bounded, but large enough for a reasoning model
		// to think before answering (issue 14: 256 tokens were consumed by
		// reasoning alone, so the JSON never arrived).
		expect(options?.maxTokens).toBeGreaterThanOrEqual(512);
		expect(options?.maxTokens).toBeLessThanOrEqual(2048);
		// OpenAI-compat gateways default thinking ON when the effort field is
		// omitted; pin the lowest effort so the model still reasons (its
		// judgment decides the preselection) but with a bounded budget.
		expect(options?.reasoning).toBe("minimal");
		expect(options?.disableReasoning).not.toBe(true);
		expect(options?.forceReasoningOff).not.toBe(true);
	});

	it("composes the caller signal with the hard timeout and degrades to an empty result when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const spy = vi.spyOn(piAi, "completeSimple").mockImplementation((_model, _context, options) => {
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return Promise.resolve(assistantJson('{"choices":[]}'));
		});
		const result = await suggestRules(
			unit("bash", { command: "git push" }),
			fakeCtx(),
			fakeRegistry(),
			undefined,
			controller.signal,
		);
		expect(result).toEqual(EMPTY_CHOICES);
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal).not.toBe(controller.signal); // composed, not the raw caller signal
		expect(options?.signal?.aborted).toBe(true);
	});

	it("still supplies a timeout signal when the caller passes none", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"choices":[]}'));
		await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal?.aborted).toBe(false);
	});

	it("the llmSuggestions gate keeps only the first choice (the preselection) and the request", async () => {
		const spy = vi
			.spyOn(piAi, "completeSimple")
			.mockResolvedValue(
				assistantJson(
					'{"choices":[{"action":"allow","remember":false,"reason":"fine"},{"action":"allow","remember":true,"pattern":"git push"}]}',
				),
			);
		const result = await suggestRules(
			unit("bash", { command: "git push" }),
			fakeCtx({ llmSuggestions: false }),
			fakeRegistry(),
		);
		expect(result.choices).toEqual([{ action: "allow", remember: false, reason: "fine" }]);
		expect(spy).toHaveBeenCalledTimes(1);
		const request = spy.mock.calls[0]?.[1] as { messages?: Array<{ content: string }> };
		expect(request.messages?.[0]?.content ?? "").toContain("Provide exactly one choice.");
	});
});

describe("createSuggestionProvider", () => {
	it("binds the session model and sessionId into each call", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"choices":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(), "session-9", fakeModel);
		await provider(unit("bash", { command: "git status" }));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
		await provider(unit("bash", { command: "git diff" }));
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("resolves a model from the registry when none is bound", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"choices":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry());
		await provider(unit("bash", { command: "git status" }));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
	});

	it("still fires for the preselection when the choices gate is off", async () => {
		const spy = vi
			.spyOn(piAi, "completeSimple")
			.mockResolvedValue(assistantJson('{"choices":[{"action":"allow","remember":false}]}'));
		const provider = createSuggestionProvider(fakeCtx({ llmSuggestions: false }), fakeRegistry(), "s", fakeModel);
		expect(await provider(unit("bash", { command: "git status" }))).toEqual(RECOMMENDED_ALLOW_ONCE);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("degrades to an empty result without calling the model when no model is available", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"choices":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(null), "s");
		expect(await provider(unit("bash", { command: "git status" }))).toEqual(EMPTY_CHOICES);
		expect(spy).not.toHaveBeenCalled();
	});
});
