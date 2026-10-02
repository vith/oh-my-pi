import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

/** `present` stand-in for spies: the controller only hands content over. */
function recordPresented(_content: Component | readonly Component[]): void {}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(
	options: {
		editorText?: string;
		goalObjective?: string;
		isCompacting?: boolean;
		isStreaming?: boolean | (() => boolean);
		runIdleCompaction?: AgentSession["runIdleCompaction"];
		runEphemeralTurn?: AgentSession["runEphemeralTurn"];
		present?: InteractiveModeContext["present"];
		sessionName?: string;
		todoPhases?: InteractiveModeContext["todoPhases"];
	} = {},
) {
	const runIdleCompaction = options.runIdleCompaction ?? (async () => {});
	const runEphemeralTurn =
		options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() }));
	const goalState: GoalModeState | undefined = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	return createInteractiveModeContext({
		sessionManager: { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		...(options.editorText !== undefined ? { editor: { getText: () => options.editorText ?? "" } } : {}),
		...(options.present ? { present: options.present } : {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			get isStreaming() {
				return typeof options.isStreaming === "function" ? options.isStreaming() : (options.isStreaming ?? false);
			},
			runIdleCompaction,
			runEphemeralTurn,
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210, contextWindow: 1_000, percent: 21 }),
			getGoalModeState: () => goalState,
		},
	});
}

describe("EventController manual recap", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("shows a requested recap after agent activity even with a draft and disabled idle recaps", async () => {
		const deferred = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const runEphemeralTurn = vi.fn(() => deferred.promise);
		const present = vi.fn(recordPresented);
		let streaming = true;
		const context = createContext({
			editorText: "unfinished draft",
			isStreaming: () => streaming,
			runEphemeralTurn,
			present,
		});
		const controller = new EventController(context);

		const recap = controller.runRecap();
		streaming = false;
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		deferred.resolve({ replyText: "Next: finish the draft", assistantMessage: createAssistantMessage() });
		await recap;

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		const notice = present.mock.calls[0]?.[0];
		expect(notice).toBeInstanceOf(RecapNotice);
		expect(
			(notice as RecapNotice)
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("Next: finish the draft");
		vi.advanceTimersByTime(60_000);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("restarts the enabled idle window after a requested recap", async () => {
		cfgRecapEnabled.override(settings, true);
		const deferred = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const runEphemeralTurn = vi
			.fn()
			.mockImplementationOnce(() => deferred.promise)
			.mockImplementation(async () => ({ replyText: "Idle follow-up", assistantMessage: createAssistantMessage() }));
		const present = vi.fn(recordPresented);
		const controller = new EventController(createContext({ runEphemeralTurn, present }));

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(30_000);
		const recap = controller.runRecap();
		vi.advanceTimersByTime(45_000);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		deferred.resolve({ replyText: "Manual now", assistantMessage: createAssistantMessage() });
		await recap;
		vi.advanceTimersByTime(59_999);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		const notice = present.mock.calls[1]?.[0];
		expect(notice).toBeInstanceOf(RecapNotice);
		expect(
			(notice as RecapNotice)
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("Idle follow-up");
		controller.dispose();
	});

	it("drops a superseded request without blocking the next turn's idle recap", async () => {
		cfgRecapEnabled.override(settings, true);
		const deferred = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const present = vi.fn(recordPresented);
		let signal: AbortSignal | undefined;
		const runEphemeralTurn = vi
			.fn()
			.mockImplementationOnce(({ signal: currentSignal }: { signal?: AbortSignal }) => {
				signal = currentSignal;
				return deferred.promise;
			})
			.mockImplementation(async () => ({
				replyText: "Fresh idle recap",
				assistantMessage: createAssistantMessage(),
			}));
		const controller = new EventController(createContext({ present, runEphemeralTurn }));
		const recap = controller.runRecap();
		await controller.handleEvent({ type: "agent_start" });
		expect(signal?.aborted).toBe(true);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		deferred.resolve({ replyText: "Stale recap", assistantMessage: createAssistantMessage() });
		await recap;
		expect(present).toHaveBeenCalledTimes(1);
		const notice = present.mock.calls[0]?.[0];
		expect(notice).toBeInstanceOf(RecapNotice);
		expect(
			(notice as RecapNotice)
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("Fresh idle recap");
		controller.dispose();
	});
});

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("arms idle compaction when it is enabled after the turn becomes idle", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgCompactionIdleEnabled.set(settings, true);
		controller.refreshIdleCompactionTimer();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("arms the idle recap when enabled mid-idle and never re-delivers a shown recap", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 60,
			},
		});
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Recap body.",
			assistantMessage: createAssistantMessage(),
		}));
		const context = createContext({ runEphemeralTurn });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgRecapEnabled.override(settings, true);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);

		// Same idle window: a later setting change must not schedule a second recap.
		cfgRecapIdleSeconds.override(settings, 90);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(90_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("emits an LLM-generated recap after the default four-minute delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const present = vi.fn(recordPresented);
		let capturedPrompt = "";
		const runEphemeralTurn = vi.fn(async (args: { promptText: string; signal?: AbortSignal }) => {
			capturedPrompt = args.promptText;
			return {
				replyText: "Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
				assistantMessage: createAssistantMessage(),
			};
		});
		const context = createContext({
			sessionName: "Fix login flow",
			present,
			runEphemeralTurn,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(239_999);
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		// Live goal/title and the active todo task anchor the recap prompt the snapshot can't guarantee.
		expect(capturedPrompt).toContain("Fix login flow");
		expect(capturedPrompt).toContain("Wire focused tests");

		const notice = present.mock.calls
			.map(([content]) => content)
			.find((content): content is RecapNotice => content instanceof RecapNotice);
		expect(notice?.render(200).map(line => Bun.stripANSI(line).trim())).toEqual([
			"",
			"※ recap: Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
		]);
		controller.dispose();
	});

	it("aborts the in-flight recap and drops its late reply when disposed", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		let receivedSignal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn((args: { promptText: string; signal?: AbortSignal }) => {
			receivedSignal = args.signal;
			return promise;
		});
		const present = vi.fn(recordPresented);
		const context = createContext({ sessionName: "Fix login flow", present, runEphemeralTurn });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(240_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(receivedSignal?.aborted).toBe(false);

		controller.dispose();
		expect(receivedSignal?.aborted).toBe(true);

		// A reply that lands after cancellation must not paint a stale recap.
		resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
	});
});
