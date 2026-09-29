import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import {
	type AgentDefinition,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantToolCalls(calls: Array<{ id: string; name: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, isError: boolean): ToolResultMessage {
	const details = toolName === "yield" && !isError ? { status: "success", data: { continued: true } } : undefined;
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? "Extension request failed." : "Extension request recorded." }],
		details,
		isError,
		timestamp: Date.now(),
	};
}

interface PauseSessionHarness {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls(): number;
	disposeCalls(): number;
	bindSessionManager(sessionManager: SessionManager): void;
	recordAssistant(calls: Array<{ id: string; name: string }>): void;
	recordToolResult(toolCallId: string, toolName: string, isError: boolean): void;
}

function createPauseSession(
	onPrompt: (params: { promptIndex: number; harness: PauseSessionHarness }) => void | Promise<void>,
): PauseSessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let sessionManager: SessionManager | undefined;
	let abortCount = 0;
	let disposeCount = 0;

	const emit = (event: AgentSessionEvent): void => {
		// A listener may unsubscribe while handling the event.
		const snapshot = listeners.slice();
		for (const listener of snapshot) listener(event);
	};
	const requireSessionManager = (): SessionManager => {
		if (!sessionManager) throw new Error("Expected mocked agent session to receive its SessionManager");
		return sessionManager;
	};

	const harness: PauseSessionHarness = {
		session: undefined as unknown as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
		bindSessionManager: manager => {
			sessionManager = manager;
		},
		recordAssistant: calls => {
			const message = assistantToolCalls(calls);
			messages.push(message);
			requireSessionManager().appendMessage(message);
			emit({ type: "message_end", message } as AgentSessionEvent);
		},
		recordToolResult: (toolCallId, toolName, isError) => {
			const result = toolResult(toolCallId, toolName, isError);
			requireSessionManager().appendMessage(result);
			emit({
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: { content: result.content, details: result.details },
				isError,
			} as AgentSessionEvent);
		},
	};

	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			prompts.push({ text, options });
			await onPrompt({ promptIndex: prompts.length, harness });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages.at(-1),
		hasPendingAsyncWork: () => false,
		abort: async () => {
			abortCount += 1;
		},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => {},
		dispose: async () => {
			disposeCount += 1;
		},
		setIrcWakeTurnObserver: () => {},
		setIrcWakeTurnAdmission: (_next: unknown) => {},
		setIrcWakeTurnSettlement: (_next: unknown) => {},
		subscribeRunState: () => () => {},
	};
	harness.session = session as unknown as AgentSession;
	return harness;
}

function mockCreateAgentSession(harness: PauseSessionHarness) {
	return vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options?.sessionManager) throw new Error("Expected executor to create a persisted session manager");
		harness.bindSessionManager(options.sessionManager);
		return {
			session: harness.session,
			extensionsResult: {} as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
}

function registerRunning(id: string, session: AgentSession, sessionFile: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		session,
		sessionFile,
		status: "running",
	});
}

describe("runSubprocess recoverable terminal pause", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-executor-pause-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function options(id: string) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "record a blocking extension request",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	it("keeps the first successful pause result recorded and the session revivable without a yield reminder", async () => {
		const id = "PausedExtension";
		const toolName = "test_pause_extension";
		const firstToolCallId = "pause-first";
		const sessionFile = path.join(tempDir.path(), `${id}.jsonl`);
		const eventBus = new EventBus();
		const lifecycleStatuses: SubagentLifecyclePayload["status"][] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, event => {
			lifecycleStatuses.push((event as SubagentLifecyclePayload).status);
		});
		subprocessToolRegistry.register(toolName, {
			terminalDisposition: event => (event.isError ? undefined : "pause"),
			// A disposition must win over this compatibility handler: the old
			// boolean would otherwise route the paused turn through hard abort.
			shouldTerminate: () => true,
		});
		const harness = createPauseSession(({ promptIndex, harness: session }) => {
			if (promptIndex !== 1) return;
			session.recordAssistant([
				{ id: firstToolCallId, name: toolName },
				{ id: "pause-second", name: toolName },
			]);
			session.recordToolResult(firstToolCallId, toolName, false);
			session.recordToolResult("pause-second", toolName, false);
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, sessionFile);

		const result = await runSubprocess({ ...options(id), eventBus });

		const jsonlEntries = (await Bun.file(sessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string; message?: ToolResultMessage });
		expect(
			jsonlEntries.some(
				entry =>
					entry.type === "message" &&
					entry.message?.role === "toolResult" &&
					entry.message.toolCallId === firstToolCallId &&
					entry.message.toolName === toolName &&
					entry.message.isError === false,
			),
		).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.paused).toEqual({ toolName, toolCallId: firstToolCallId });
		expect(result.aborted).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(harness.prompts).toHaveLength(1);
		expect(harness.abortCalls()).toBe(1);
		expect(harness.disposeCalls()).toBe(0);
		expect(lifecycleStatuses).toEqual(["started", "paused"]);
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(await AgentLifecycleManager.global().ensureLive(id)).toBe(harness.session);
	});

	it("stops immediately when a synthetic yield reminder pauses", async () => {
		const id = "ReminderPausedExtension";
		const toolName = "test_reminder_pause_extension";
		subprocessToolRegistry.register(toolName, {
			terminalDisposition: event => (event.isError ? undefined : "pause"),
		});
		const harness = createPauseSession(({ promptIndex, harness: session }) => {
			if (promptIndex === 1) {
				session.recordAssistant([]);
				return;
			}
			if (promptIndex === 2) {
				session.recordAssistant([{ id: "pause-from-reminder", name: toolName }]);
				session.recordToolResult("pause-from-reminder", toolName, false);
			}
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, path.join(tempDir.path(), `${id}.jsonl`));

		const result = await runSubprocess(options(id));

		expect(result.paused).toEqual({ toolName, toolCallId: "pause-from-reminder" });
		expect(harness.prompts).toHaveLength(2);
	});

	it("does not settle async work after a pause from the async-pending notice", async () => {
		const id = "AsyncNoticePausedExtension";
		const toolName = "test_async_notice_pause_extension";
		let pending = true;
		let settleCalls = 0;
		subprocessToolRegistry.register(toolName, {
			terminalDisposition: event => (event.isError ? undefined : "pause"),
		});
		const harness = createPauseSession(({ promptIndex, harness: session }) => {
			if (promptIndex === 1) {
				session.recordAssistant([{ id: "yield-before-notice", name: "yield" }]);
				session.recordToolResult("yield-before-notice", "yield", false);
				return;
			}
			if (promptIndex === 2) {
				session.recordAssistant([{ id: "pause-from-async-notice", name: toolName }]);
				session.recordToolResult("pause-from-async-notice", toolName, false);
			}
		});
		Object.assign(harness.session, {
			hasPendingAsyncWork: () => pending,
			getAsyncJobSnapshot: () => ({ running: [{ id: "extension-request" }] }),
			settleAsyncWork: async () => {
				settleCalls++;
				pending = false;
			},
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, path.join(tempDir.path(), `${id}.jsonl`));

		const result = await runSubprocess(options(id));

		expect(result.paused).toEqual({ toolName, toolCallId: "pause-from-async-notice" });
		expect(harness.prompts).toHaveLength(2);
		expect(settleCalls).toBe(0);
	});

	it("lets a caller abort supersede a pause before lifecycle settlement", async () => {
		const id = "CancelledDuringPause";
		const toolName = "test_abort_pause_extension";
		const controller = new AbortController();
		subprocessToolRegistry.register(toolName, { terminalDisposition: () => "pause" });
		const harness = createPauseSession(({ harness: session }) => {
			session.recordAssistant([{ id: "pause-before-cancel", name: toolName }]);
			session.recordToolResult("pause-before-cancel", toolName, false);
			controller.abort("caller cancelled");
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, path.join(tempDir.path(), `${id}.jsonl`));

		const result = await runSubprocess({ ...options(id), signal: controller.signal });

		expect(result.paused).toBeUndefined();
		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)?.status).not.toBe("idle");
	});

	it("does not claim an unrecoverable one-shot helper can be resumed", async () => {
		const id = "OneShotPause";
		const toolName = "test_one_shot_pause_extension";
		subprocessToolRegistry.register(toolName, { terminalDisposition: () => "pause" });
		const harness = createPauseSession(({ harness: session }) => {
			session.recordAssistant([{ id: "one-shot-call", name: toolName }]);
			session.recordToolResult("one-shot-call", toolName, false);
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, path.join(tempDir.path(), `${id}.jsonl`));

		const result = await runSubprocess({ ...options(id), keepAlive: false });

		expect(result.paused).toBeUndefined();
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("does not retain its session");
		expect(harness.disposeCalls()).toBe(1);
	});

	it("escapes a pending owner-job settle when an external operation pauses the run", async () => {
		const id = "PausedWhileSettling";
		const toolName = "test_pause_during_owner_settle";
		let settleCalls = 0;
		const neverSettles = Promise.withResolvers<void>();
		subprocessToolRegistry.register(toolName, { terminalDisposition: () => "pause" });
		const harness = createPauseSession(({ harness: session }) => {
			session.recordAssistant([]);
		});
		Object.assign(harness.session, {
			hasPendingAsyncWork: () => true,
			settleAsyncWork: () => {
				settleCalls++;
				queueMicrotask(() => {
					harness.recordAssistant([{ id: "pause-during-settle", name: toolName }]);
					harness.recordToolResult("pause-during-settle", toolName, false);
				});
				return neverSettles.promise;
			},
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, path.join(tempDir.path(), `${id}.jsonl`));

		const result = await runSubprocess(options(id));

		expect(result.paused).toEqual({ toolName, toolCallId: "pause-during-settle" });
		expect(settleCalls).toBe(1);
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
	});

	it("does not pause when a terminal-disposition tool result is an error", async () => {
		const id = "FailedExtension";
		const toolName = "test_pause_error_extension";
		const sessionFile = path.join(tempDir.path(), `${id}.jsonl`);
		subprocessToolRegistry.register(toolName, {
			terminalDisposition: () => "pause",
		});
		const harness = createPauseSession(({ promptIndex, harness: session }) => {
			if (promptIndex === 1) {
				session.recordAssistant([{ id: "pause-error", name: toolName }]);
				session.recordToolResult("pause-error", toolName, true);
				return;
			}
			session.recordAssistant([{ id: "yield-after-error", name: "yield" }]);
			session.recordToolResult("yield-after-error", "yield", false);
		});
		mockCreateAgentSession(harness);
		registerRunning(id, harness.session, sessionFile);

		const result = await runSubprocess(options(id));

		expect(harness.prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.paused).toBeUndefined();
		expect(result.aborted).toBe(false);
	});
});
