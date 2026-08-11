import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { EngineContext } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import { normalizeRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import {
	createSuggestionProvider,
	type Suggestion,
	suggestRules,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/suggest";

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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("suggestRules", () => {
	it("returns validated suggestions parsed from the model's JSON", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'[{"tool":"bash","match":{"command":"git push"},"action":"allow","reason":"safe push"},{"tool":"bash","match":{"command":"git *"},"action":"deny","reason":"untrusted git"}]',
			),
		);
		const suggestions = await suggestRules("git push", fakeCtx(), fakeRegistry());
		expect(suggestions).toHaveLength(2);
		for (const suggestion of suggestions) {
			expect(normalizeRule({ ...suggestion.rule, layer: "dynamic" }, "dynamic")).not.toBeNull();
		}
		expect(suggestions[0]?.rule.tool).toBe("bash");
		expect(suggestions[0]?.rule.action).toBe("allow");
		expect(suggestions[0]?.rule.match).toEqual({ command: "git push" });
		expect(suggestions[0]?.rationale).toBe("safe push");
		expect(suggestions[1]?.rule.action).toBe("deny");
	});

	it("caps suggestions at 3 even when the model returns more", async () => {
		const records = Array.from({ length: 6 }, (_, index) => ({
			tool: "bash",
			match: { command: `cmd ${index}` },
			action: "allow",
		}));
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson(JSON.stringify(records)));
		const suggestions = await suggestRules("cmd", fakeCtx(), fakeRegistry());
		expect(suggestions).toHaveLength(3);
	});

	it("degrades to [] when the response is not a JSON array", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("sure, just allow it"));
		expect(await suggestRules("git push", fakeCtx(), fakeRegistry())).toEqual([]);
	});

	it("degrades to [] when completeSimple rejects", async () => {
		vi.spyOn(piAi, "completeSimple").mockRejectedValue(new Error("provider down"));
		expect(await suggestRules("git push", fakeCtx(), fakeRegistry())).toEqual([]);
	});

	it("degrades to [] when the provider reports a stopReason of error", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "rate limited",
			content: [],
		} as never);
		expect(await suggestRules("git push", fakeCtx(), fakeRegistry())).toEqual([]);
	});

	it("drops malformed records and keeps valid ones", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'[{"tool":"bash","match":{"command":"git push"},"action":"allow","reason":"ok"},{"tool":"","match":{},"action":"allow"},{"action":"allow"}]',
			),
		);
		const suggestions = await suggestRules("git push", fakeCtx(), fakeRegistry());
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.rule.tool).toBe("bash");
	});

	it("never suggests denying curated read-only tools", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson(
				'[{"tool":"read","match":{"path":"/etc/passwd"},"action":"deny","reason":"secret"},{"tool":"read","match":{"path":"src/**"},"action":"allow","reason":"fine"},{"tool":"bash","match":{"command":"rm -rf /"},"action":"deny","reason":"dangerous"}]',
			),
		);
		const suggestions = await suggestRules("read /etc/passwd", fakeCtx(), fakeRegistry());
		expect(suggestions).toHaveLength(2);
		expect(suggestions.some(s => s.rule.action === "deny" && s.rule.tool === "read")).toBe(false);
		expect(suggestions.some(s => s.rule.action === "allow" && s.rule.tool === "read")).toBe(true);
		expect(suggestions.some(s => s.rule.tool === "bash" && s.rule.action === "deny")).toBe(true);
	});

	it("sends the imported system prompt with the piece, cwd, and current rules", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		await suggestRules("git push", fakeCtx(), fakeRegistry(), "session-1");
		const request = spy.mock.calls[0]?.[1] as { systemPrompt?: string[]; messages?: Array<{ content: string }> };
		expect(request?.systemPrompt).toBeDefined();
		const systemPrompt = request.systemPrompt?.join("\n") ?? "";
		expect(systemPrompt.length).toBeGreaterThan(0);
		expect(systemPrompt).toContain("policy assistant");
		const userMessage = request.messages?.[0]?.content ?? "";
		expect(userMessage).toContain("git push");
		expect(userMessage).toContain("/tmp/suggest-proj");
		const options = spy.mock.calls[0]?.[2] as { apiKey?: unknown; maxTokens?: number; signal?: AbortSignal };
		expect(options?.apiKey).toBeDefined();
		expect(options?.maxTokens).toBeLessThanOrEqual(512);
	});

	it("composes the caller signal with the 8s timeout and degrades to [] when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const spy = vi.spyOn(piAi, "completeSimple").mockImplementation((_model, _context, options) => {
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return Promise.resolve(assistantJson("[]"));
		});
		const suggestions = await suggestRules("git push", fakeCtx(), fakeRegistry(), undefined, controller.signal);
		expect(suggestions).toEqual([]);
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal).not.toBe(controller.signal); // composed, not the raw caller signal
		expect(options?.signal?.aborted).toBe(true);
	});

	it("still supplies a timeout signal when the caller passes none", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		await suggestRules("git push", fakeCtx(), fakeRegistry());
		const options = spy.mock.calls[0]?.[2] as { signal?: AbortSignal };
		expect(options?.signal).toBeDefined();
		expect(options?.signal?.aborted).toBe(false);
	});

	it("is gated by the permissions.llmSuggestions setting", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		const suggestions = await suggestRules("git push", fakeCtx({ llmSuggestions: false }), fakeRegistry());
		expect(suggestions).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("createSuggestionProvider", () => {
	it("binds the session model and sessionId into each call", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(), "session-9", fakeModel);
		await provider("git status");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
		await provider("git diff");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("resolves a model from the registry when none is bound", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry());
		await provider("git status");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(fakeModel);
	});

	it("degrades to [] without calling the model when the gate is off", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		const provider = createSuggestionProvider(fakeCtx({ llmSuggestions: false }), fakeRegistry(), "s", fakeModel);
		expect(await provider("git status")).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("degrades to [] without calling the model when no model is available", async () => {
		const spy = vi.spyOn(piAi, "completeSimple").mockResolvedValue(assistantJson("[]"));
		const provider = createSuggestionProvider(fakeCtx(), fakeRegistry(null), "s");
		expect(await provider("git status")).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("Suggestion shape", () => {
	it("produces rules that writeDynamicRule-compatible round-trip through normalizeRule", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue(
			assistantJson('[{"tool":"write","match":{"path":"src/**"},"action":"allow","reason":"codegen"}]'),
		);
		const suggestions = await suggestRules("write src/x.ts", fakeCtx(), fakeRegistry());
		expect(suggestions).toHaveLength(1);
		const suggestion: Suggestion = suggestions[0]!;
		expect(suggestion.rule).not.toHaveProperty("layer");
		const roundTripped = normalizeRule({ ...suggestion.rule, layer: "dynamic" }, "dynamic");
		expect(roundTripped).not.toBeNull();
		expect(roundTripped?.reason).toBe("codegen");
	});
});
