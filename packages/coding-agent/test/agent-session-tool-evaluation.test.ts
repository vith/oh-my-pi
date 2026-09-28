import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const call = {
	customType: "extension-call",
	content: '<invoke name="uppercase"><parameter name="text">true</parameter></invoke>',
	display: false,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("extension tool evaluation", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let session: AgentSession | undefined;
	const releases: Array<() => void> = [];

	beforeEach(async () => {
		directory = TempDir.createSync("omp-tool-evaluation-");
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		auth.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		await session?.dispose();
		auth.close();
		directory.removeSync();
	});

	function createSession(blockFirstTurn = false) {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const contexts: Context[] = [];
		let interrupted = false;
		const uppercaseArgs = type({ text: "string" });
		const uppercase: AgentTool = {
			name: "uppercase",
			label: "Uppercase",
			description: "Uppercase text",
			parameters: uppercaseArgs,
			execute: async (_id, args) => ({
				content: [{ type: "text", text: uppercaseArgs.assert(args).text.toUpperCase() }],
			}),
		};
		const slow: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Wait for release",
			parameters: type({}),
			execute: async (_id, _args, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						interrupted = true;
					},
					{ once: true },
				);
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }] };
			},
		};
		const model = createMockModel({ provider: "openai", id: "tool-evaluation" }).model;
		const tools = [uppercase, slow];
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			streamFn: (_model, context) => {
				const invokeSlow = blockFirstTurn && contexts.length === 0;
				contexts.push({ ...context, messages: structuredClone(context.messages) });
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: invokeSlow
						? [{ type: "toolCall", id: "slow-call", name: "slow", arguments: {} }]
						: [{ type: "text", text: "Done" }],
					usage,
					stopReason: invokeSlow ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: invokeSlow ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			settings,
			modelRegistry: new ModelRegistry(auth),
			sessionManager: SessionManager.inMemory(directory.path()),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		return { session, contexts, started: started.promise, release: release.resolve, interrupted: () => interrupted };
	}

	it("executes schema-string XML arguments and persists a paired assistant/result exchange without a provider turn", async () => {
		const harness = createSession();
		expect(await harness.session.sendCustomMessage(call, { evaluateToolCalls: true })).toBe(false);
		expect(harness.contexts).toEqual([]);
		const messages = harness.session.buildDisplaySessionContext().messages;
		const assistant = messages.find(message => message.role === "assistant");
		const result = messages.find(message => message.role === "toolResult");
		expect(assistant?.role).toBe("assistant");
		expect(result?.role).toBe("toolResult");
		if (assistant?.role !== "assistant" || result?.role !== "toolResult") throw new Error("Missing tool exchange");
		expect(assistant.content).toEqual([
			{ type: "toolCall", id: result.toolCallId, name: "uppercase", arguments: { text: "true" } },
		]);
		expect(result.content).toEqual([{ type: "text", text: "TRUE" }]);
		expect(result.isError).toBe(false);
	});

	it("keeps nextTurn results out of the active run and delivers them with the next explicit prompt", async () => {
		const harness = createSession(true);
		const run = harness.session.prompt("start");
		await harness.started;
		await harness.session.sendCustomMessage(call, { evaluateToolCalls: true, deliverAs: "nextTurn" });
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		harness.release();
		await run;
		await harness.session.waitForIdle();
		expect(
			harness.contexts.some(context =>
				context.messages.some(message => message.role === "toolResult" && message.toolName === "uppercase"),
			),
		).toBe(false);
		await harness.session.prompt("next");
		const context = harness.contexts.at(-1)!;
		expect(
			context.messages.find(message => message.role === "toolResult" && message.toolName === "uppercase")?.content,
		).toEqual([{ type: "text", text: "TRUE" }]);
		expect(harness.interrupted()).toBe(false);
	});

	it("delivers aside results at a step boundary without interrupting an in-flight tool", async () => {
		const harness = createSession(true);
		const run = harness.session.prompt("start");
		await harness.started;
		await harness.session.sendCustomMessage(call, { evaluateToolCalls: true, deliverAs: "aside" });
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		harness.release();
		await run;
		await harness.session.waitForIdle();
		expect(
			harness.contexts[1]?.messages.find(
				message => message.role === "toolResult" && message.toolName === "uppercase",
			)?.content,
		).toEqual([{ type: "text", text: "TRUE" }]);
		expect(harness.interrupted()).toBe(false);
	});
});
