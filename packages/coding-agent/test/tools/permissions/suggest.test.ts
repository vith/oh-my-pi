import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { EngineContext } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import { normalizeRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import {
	createSuggestionProvider,
	type Suggestion,
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

const RULES_ONLY = { suggestions: [] };
const RECOMMENDED_ALLOW_ONCE = {
	suggestions: [],
	recommendation: { action: "allow" as const, scope: "once" as const },
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("suggestRules", () => {
	it("returns the recommendation and validated suggestions parsed from the model's JSON", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'{"recommendation":{"action":"allow","scope":"pattern","reason":"safe push"},"rules":[{"tool":"bash","match":{"command":"git push"},"action":"allow","reason":"safe push"},{"tool":"bash","match":{"command":"git *"},"action":"deny","reason":"untrusted git"}]}',
			),
		);
		const result = await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		expect(result.recommendation).toEqual({ action: "allow", scope: "pattern", reason: "safe push" });
		expect(result.suggestions).toHaveLength(2);
		for (const suggestion of result.suggestions) {
			expect(normalizeRule({ ...suggestion.rule, layer: "user" }, "user")).not.toBeNull();
		}
		expect(result.suggestions[0]?.rule.tool).toBe("bash");
		expect(result.suggestions[0]?.rule.action).toBe("allow");
		expect(result.suggestions[0]?.rule.match).toEqual({ command: "git push" });
		expect(result.suggestions[0]?.rationale).toBe("safe push");
		expect(result.suggestions[1]?.rule.action).toBe("deny");
	});

	it("caps suggestions at 3 even when the model returns more", async () => {
		const records = Array.from({ length: 6 }, (_, index) => ({
			tool: "bash",
			match: { command: `cmd ${index}` },
			action: "allow",
		}));
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(JSON.stringify({ recommendation: { action: "allow", scope: "once" }, rules: records })),
		);
		const result = await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry());
		expect(result.suggestions).toHaveLength(3);
	});

	it("keeps a valid recommendation and degrades malformed ones to none", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"recommendation":{"action":"maybe","scope":"once"},"rules":[]}'),
		);
		const result = await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry());
		expect(result.recommendation).toBeUndefined();

		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"recommendation":{"action":"allow","scope":"weekly"},"rules":[]}'),
		);
		expect(
			(await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry())).recommendation,
		).toBeUndefined();

		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"recommendation":{"action":"deny","scope":"tool","reason":"dangerous"},"rules":[]}'),
		);
		expect((await suggestRules(unit("bash", { command: "cmd" }), fakeCtx(), fakeRegistry())).recommendation).toEqual({
			action: "deny",
			scope: "tool",
			reason: "dangerous",
		});
	});

	it("degrades to an empty result when the response is not a JSON object", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("sure, just allow it"));
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(RULES_ONLY);
	});

	it("degrades to an empty result when completeSimple rejects", async () => {
		vi.spyOn(piAi, "completeSimple").mockRejectedValue(new Error("provider down"));
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(RULES_ONLY);
	});

	it("degrades to an empty result when the provider reports a stopReason of error", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "rate limited",
			content: [],
		} as never);
		expect(await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry())).toEqual(RULES_ONLY);
	});

	it("drops malformed records and keeps valid ones", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'{"rules":[{"tool":"bash","match":{"command":"git push"},"action":"allow","reason":"ok"},{"tool":"","match":{},"action":"allow"},{"action":"allow"}]}',
			),
		);
		const result = await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0]?.rule.tool).toBe("bash");
	});

	it("never suggests denying curated read-only tools", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'{"rules":[{"tool":"read","match":{"path":"/etc/passwd"},"action":"deny","reason":"secret"},{"tool":"read","match":{"path":"src/**"},"action":"allow","reason":"fine"},{"tool":"bash","match":{"command":"rm -rf /"},"action":"deny","reason":"dangerous"}]}',
			),
		);
		const result = await suggestRules(unit("read", { path: "/etc/passwd" }), fakeCtx(), fakeRegistry());
		expect(result.suggestions).toHaveLength(2);
		expect(result.suggestions.some(s => s.rule.action === "deny" && s.rule.tool === "read")).toBe(false);
		expect(result.suggestions.some(s => s.rule.action === "allow" && s.rule.tool === "read")).toBe(true);
		expect(result.suggestions.some(s => s.rule.tool === "bash" && s.rule.action === "deny")).toBe(true);
	});

	it("sends the imported system prompt with the call, cwd, current rules, and mechanical candidates", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
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
		// And the dialog's scope rules: no tool-wide bash.
		expect(systemPrompt).toContain('never recommend "tool" scope for bash');
		const userMessage = request.messages?.[0]?.content ?? "";
		expect(userMessage).toContain("git push");
		expect(userMessage).toContain("Tool: bash");
		expect(userMessage).toContain('Arguments: {"command":"git push"}');
		expect(userMessage).toContain("/tmp/suggest-proj");
		// The mechanical candidates the dialog offers on its own.
		expect(userMessage).toContain("- Exact: git push");
		expect(userMessage).toContain("- Pattern: git *");
		const options = spy.mock.calls[0]?.[2] as { apiKey?: unknown; maxTokens?: number; signal?: AbortSignal };
		expect(options?.apiKey).toBeDefined();
		expect(options?.maxTokens).toBeLessThanOrEqual(512);
	});

	it("shows file-tool candidates as an exact path and a parent glob", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
		await suggestRules(unit("write", { path: "src/foo/bar.ts" }), fakeCtx(), fakeRegistry());
		const request = spy.mock.calls[0]?.[1] as { messages?: Array<{ content: string }> };
		const userMessage = request.messages?.[0]?.content ?? "";
		expect(userMessage).toContain("- Exact: src/foo/bar.ts");
		expect(userMessage).toContain("- Pattern: src/foo/**");
	});

	it("never surfaces a tool-wide bash allow suggestion", async () => {
		const spy = vi
			.spyOn(piAi, "completeSimple")
			.mockResolvedValue(
				assistantJson(
					'{"rules":[{"tool":"bash","match":{"command":"*"},"action":"allow"},{"tool":"bash","match":{"command":"*"},"action":"deny"},{"tool":"bash","match":{"command":"git status *"},"action":"allow"}]}',
				),
			);
		const result = await suggestRules(unit("bash", { command: "git status" }), fakeCtx(), fakeRegistry());
		expect(spy).toHaveBeenCalledTimes(1);
		const tools = result.suggestions.map(s => `${s.rule.action} ${s.rule.match.command}`);
		// The yolo-knob allow is dropped; the same-shape deny and the family
		// allow survive.
		expect(tools).toEqual(["deny *", "allow git status *"]);
	});

	it("composes the caller signal with the 8s timeout and degrades to an empty result when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const spy = vi.spyOn(piAi, "completeSimple").mockImplementation((_model, _context, options) => {
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return Promise.resolve(assistantJson('{"rules":[]}'));
		});
		const result = await suggestRules(
			unit("bash", { command: "git push" }),
			fakeCtx(),
			fakeRegistry(),
			undefined,
			controller.signal,
		);
		expect(result).toEqual(RULES_ONLY);
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal).not.toBe(controller.signal); // composed, not the raw caller signal
		expect(options?.signal?.aborted).toBe(true);
	});

	it("still supplies a timeout signal when the caller passes none", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
		await suggestRules(unit("bash", { command: "git push" }), fakeCtx(), fakeRegistry());
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal?.aborted).toBe(false);
	});

	it("the llmSuggestions gate drops the rules but keeps the recommendation and the request", async () => {
		const spy = vi
			.spyOn(piAi, "completeSimple")
			.mockResolvedValue(
				assistantJson(
					'{"recommendation":{"action":"allow","scope":"once","reason":"fine"},"rules":[{"tool":"bash","match":{"command":"git push"},"action":"allow"}]}',
				),
			);
		const result = await suggestRules(
			unit("bash", { command: "git push" }),
			fakeCtx({ llmSuggestions: false }),
			fakeRegistry(),
		);
		expect(result.recommendation).toEqual({ action: "allow", scope: "once", reason: "fine" });
		expect(result.suggestions).toEqual([]);
		expect(spy).toHaveBeenCalledTimes(1);
		const request = spy.mock.calls[0]?.[1] as { messages?: Array<{ content: string }> };
		expect(request.messages?.[0]?.content ?? "").toContain("Do not include a rules array");
	});
});

describe("createSuggestionProvider", () => {
	it("binds the session model and sessionId into each call", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(), "session-9", fakeModel);
		await provider(unit("bash", { command: "git status" }));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
		await provider(unit("bash", { command: "git diff" }));
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("resolves a model from the registry when none is bound", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry());
		await provider(unit("bash", { command: "git status" }));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
	});

	it("still fires for the recommendation when the rules gate is off", async () => {
		const spy = vi
			.spyOn(piAi, "completeSimple")
			.mockResolvedValue(assistantJson('{"recommendation":{"action":"allow","scope":"once"}}'));
		const provider = createSuggestionProvider(fakeCtx({ llmSuggestions: false }), fakeRegistry(), "s", fakeModel);
		expect(await provider(unit("bash", { command: "git status" }))).toEqual(RECOMMENDED_ALLOW_ONCE);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("degrades to an empty result without calling the model when no model is available", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson('{"rules":[]}'));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(null), "s");
		expect(await provider(unit("bash", { command: "git status" }))).toEqual(RULES_ONLY);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("Suggestion shape", () => {
	it("produces rules that writeDynamicRule-compatible round-trip through normalizeRule", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('{"rules":[{"tool":"write","match":{"path":"src/**"},"action":"allow","reason":"codegen"}]}'),
		);
		const result = await suggestRules(unit("write", { path: "src/x.ts" }), fakeCtx(), fakeRegistry());
		expect(result.suggestions).toHaveLength(1);
		const suggestion: Suggestion = result.suggestions[0]!;
		expect(suggestion.rule).not.toHaveProperty("layer");
		const roundTripped = normalizeRule({ ...suggestion.rule, layer: "user" }, "user");
		expect(roundTripped).not.toBeNull();
		expect(roundTripped?.reason).toBe("codegen");
	});
});
