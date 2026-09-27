import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { inspectDurableFollowUp } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession persisted custom prompt", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.[Symbol.dispose]();
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
	});

	function textFromProviderContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "text" &&
					"text" in block &&
					typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n");
	}

	it("flushes a persisted custom prompt before the provider observes it without duplicating its entry", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const providerStarted = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		let transcriptAtProviderStart = "";
		const mock = createMockModel({
			handler: async () => {
				transcriptAtProviderStart = await Bun.file(sessionFile).text();
				providerStarted.resolve();
				await releaseProvider.promise;
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const turn = session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});
		await providerStarted.promise;

		expect(transcriptAtProviderStart.match(/resolution:r1/g)).toHaveLength(1);
		releaseProvider.resolve();
		await turn;
		await sessionManager.flush();
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await sessionManager.close();
	});

	it("reserves the durable turn before its flush so a competing direct prompt cannot interleave", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const flushEntered = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const flush = sessionManager.flush.bind(sessionManager);
		let flushCount = 0;
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			flushCount++;
			if (flushCount === 1) {
				flushEntered.resolve();
				await releaseFlush.promise;
			}
			await flush();
		});
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const durableTurn = session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});
		await flushEntered.promise;
		try {
			await expect(session.prompt("competing direct prompt")).rejects.toBeInstanceOf(AgentBusyError);
			expect(mock.calls).toHaveLength(0);
		} finally {
			releaseFlush.resolve();
			await durableTurn;
		}
		await sessionManager.close();
	});

	it("reconciles a flushed durable prompt into live context when cancellation suppresses provider start", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		let providerStarts = 0;
		const mock = createMockModel({
			handler: () => {
				providerStarts++;
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const flush = sessionManager.flush.bind(sessionManager);
		let cancelAfterFlush = true;
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			await flush();
			if (cancelAfterFlush) {
				cancelAfterFlush = false;
				await session?.abort();
			}
		});

		await session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});

		expect(providerStarts).toBe(0);
		const transcriptBeforeRepeat = await Bun.file(sessionFile).text();
		expect(transcriptBeforeRepeat.match(/resolution:r1/g)).toHaveLength(1);
		expect(
			agent.state.messages.filter(
				message =>
					message.role === "custom" &&
					message.customType === "subagent-durable-follow-up" &&
					message.details !== null &&
					typeof message.details === "object" &&
					"deliveryKey" in message.details &&
					message.details.deliveryKey === "resolution:r1",
			),
		).toHaveLength(1);
		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("appended");
		expect(await Bun.file(sessionFile).text()).toBe(transcriptBeforeRepeat);
		await sessionManager.close();
	});

	it("keeps direct prompts fenced after abort until durable reconciliation completes", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const durableFlushCompleted = Promise.withResolvers<void>();
		const releaseDurableContinuation = Promise.withResolvers<void>();
		const flush = sessionManager.flush.bind(sessionManager);
		let blockFirstFlush = true;
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			await flush();
			if (!blockFirstFlush) return;
			blockFirstFlush = false;
			durableFlushCompleted.resolve();
			await releaseDurableContinuation.promise;
		});

		let providerStarts = 0;
		const mock = createMockModel({
			handler: () => {
				providerStarts++;
				return { content: ["Unrelated answer"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const durableTurn = session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});
		await durableFlushCompleted.promise;
		await session.abort();

		let competingPromptError: unknown;
		try {
			await session.prompt("competing direct prompt");
		} catch (error) {
			competingPromptError = error;
		} finally {
			releaseDurableContinuation.resolve();
			await durableTurn;
		}

		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("appended");
		expect(competingPromptError).toBeInstanceOf(AgentBusyError);
		expect(providerStarts).toBe(0);
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await sessionManager.close();
	});

	it("defers a queued nextTurn trigger until cancelled durable reconciliation restores its context", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const durableFlushCompleted = Promise.withResolvers<void>();
		const releaseDurableContinuation = Promise.withResolvers<void>();
		const flush = sessionManager.flush.bind(sessionManager);
		let blockFirstFlush = true;
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			await flush();
			if (!blockFirstFlush) return;
			blockFirstFlush = false;
			durableFlushCompleted.resolve();
			await releaseDurableContinuation.promise;
		});

		const durableMarker = "DURABLE-PORT-8080";
		const queuedMarker = "QUEUED-NEXT-TURN";
		const providerStarted = Promise.withResolvers<void>();
		let providerStarts = 0;
		let durableMarkersAtProvider = 0;
		let queuedMarkersAtProvider = 0;
		const mock = createMockModel({
			handler: context => {
				providerStarts++;
				const providerText = context.messages.map(message => textFromProviderContent(message.content)).join("\n");
				durableMarkersAtProvider = providerText.match(new RegExp(durableMarker, "g"))?.length ?? 0;
				queuedMarkersAtProvider = providerText.match(new RegExp(queuedMarker, "g"))?.length ?? 0;
				providerStarted.resolve();
				return { content: ["Queued turn answered with durable context"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const durableTurn = session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: durableMarker,
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});
		await durableFlushCompleted.promise;
		await session.abort();

		try {
			const started = await session.sendCustomMessage(
				{
					customType: "queued-next-turn",
					content: queuedMarker,
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			expect(started).toBe(false);
			await Bun.sleep(50);
			await sessionManager.flush();
			expect({
				delivery: await inspectDurableFollowUp(sessionFile, "resolution:r1"),
				providerStarts,
			}).toEqual({ delivery: "appended", providerStarts: 0 });
		} finally {
			releaseDurableContinuation.resolve();
			await durableTurn;
		}

		await providerStarted.promise;
		await session.waitForIdle();
		await sessionManager.flush();
		expect(providerStarts).toBe(1);
		expect(durableMarkersAtProvider).toBe(1);
		expect(queuedMarkersAtProvider).toBe(1);
		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("answered");
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await sessionManager.close();
	});

	it("keeps the durable message singular through forced pre-prompt compaction", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		const seedUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "seed user context".repeat(40) }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "seed assistant context".repeat(40) }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now() - 1,
		};
		// Keep a complete earlier turn so pre-prompt compaction has a real cut
		// point; a single turn cannot be summarized before this durable prompt.
		const olderUser = {
			...seedUser,
			content: [{ type: "text" as const, text: "older user context".repeat(40) }],
			timestamp: Date.now() - 4,
		};
		const olderAssistant = {
			...seedAssistant,
			content: [{ type: "text" as const, text: "older assistant context".repeat(40) }],
			timestamp: Date.now() - 3,
		};
		sessionManager.appendMessage(olderUser);
		sessionManager.appendMessage(olderAssistant);
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		let durableMessagesAtProvider = 0;
		let compactedBeforeProvider = false;
		const marker = "DURABLE-PORT-8080";
		const mock = createMockModel({
			handler: context => {
				compactedBeforeProvider = sessionManager.getEntries().some(entry => entry.type === "compaction");
				durableMessagesAtProvider = context.messages.reduce(
					(count, message) =>
						count + (textFromProviderContent(message.content).match(new RegExp(marker, "g"))?.length ?? 0),
					0,
				);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [olderUser, olderAssistant, seedUser, seedAssistant],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 50,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});

		await session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: `${marker} ${"context filler ".repeat(120)}`,
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});

		expect(compactedBeforeProvider).toBe(true);
		expect(durableMessagesAtProvider).toBe(1);
		await sessionManager.flush();
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await sessionManager.close();
	});
});
