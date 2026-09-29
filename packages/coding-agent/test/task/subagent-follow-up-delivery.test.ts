import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	inspectDurableFollowUp,
	runDurableSubagentFollowUpTurn,
	runSubagentFollowUpTurn,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { TempDir } from "@oh-my-pi/pi-utils";

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantYield(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function yieldResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "yield-1",
		toolName: "yield",
		content: [{ type: "text", text: "done" }],
		details: { status: "success", data: { continued: true } },
		isError: false,
		timestamp: Date.now(),
	};
}

function sessionEntry(id: string, parentId: string | null, entry: Record<string, unknown>): Record<string, unknown> {
	return { id, parentId, timestamp: new Date().toISOString(), ...entry };
}

async function writeTranscript(sessionFile: string, entries: Record<string, unknown>[]): Promise<void> {
	await Bun.write(
		sessionFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
			}),
			...entries.map(entry => JSON.stringify(entry)),
		].join("\n")}\n`,
	);
}

interface DurableSessionHarness {
	session: AgentSession;
	modelRequests(): number;
}

interface DeferredDurableSessionHarness extends DurableSessionHarness {
	firstModelStarted: Promise<void>;
	secondModelStarted: Promise<void>;
	releaseModel(): void;
}

function createDurableSession(manager: SessionManager): DurableSessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	let requests = 0;
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		model: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			requests++;
			const assistant = assistantYield();
			messages.push(assistant);
			manager.appendMessage(assistant);
			emit({ type: "message_end", message: assistant } as AgentSessionEvent);
			const result = yieldResult();
			manager.appendMessage(result);
			emit({
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: { content: result.content, details: result.details },
				isError: false,
			} as AgentSessionEvent);
			await manager.flush();
		},
		promptCustomMessage: async (message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			attribution?: "agent" | "user";
		}) => {
			requests++;
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution,
			);
			const assistant = assistantYield();
			messages.push(assistant);
			manager.appendMessage(assistant);
			emit({ type: "message_end", message: assistant } as AgentSessionEvent);
			const result = yieldResult();
			manager.appendMessage(result);
			emit({
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: { content: result.content, details: result.details },
				isError: false,
			} as AgentSessionEvent);
			await manager.flush();
		},
		promptCustomMessagePersisted: async (message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			attribution?: "agent" | "user";
		}) => {
			requests++;
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution,
			);
			const assistant = assistantYield();
			messages.push(assistant);
			manager.appendMessage(assistant);
			emit({ type: "message_end", message: assistant } as AgentSessionEvent);
			const result = yieldResult();
			manager.appendMessage(result);
			emit({
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: { content: result.content, details: result.details },
				isError: false,
			} as AgentSessionEvent);
			await manager.flush();
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages.at(-1),
		abort: async () => {},
		isAdvisorActive: () => false,
		getToolByName: (_name: string) => undefined,
		setWorkPoolYieldItems: async (_items: readonly unknown[]) => {},
		hasPendingAsyncWork: () => false,
		setIrcWakeTurnObserver: () => {},
		setIrcWakeTurnAdmission: (_next: unknown) => {},
		setIrcWakeTurnSettlement: (_next: unknown) => {},
		subscribeRunState: () => () => {},
	};
	return { session: session as unknown as AgentSession, modelRequests: () => requests };
}

function createDeferredDurableSession(manager: SessionManager): DeferredDurableSessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const firstModelStarted = Promise.withResolvers<void>();
	const secondModelStarted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const finishTurn = async (): Promise<void> => {
		const assistant = assistantYield();
		messages.push(assistant);
		manager.appendMessage(assistant);
		emit({ type: "message_end", message: assistant } as AgentSessionEvent);
		const result = yieldResult();
		manager.appendMessage(result);
		emit({
			type: "tool_execution_end",
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			result: { content: result.content, details: result.details },
			isError: false,
		} as AgentSessionEvent);
		await manager.flush();
	};
	const beginProvider = async (): Promise<void> => {
		requests++;
		if (requests === 1) firstModelStarted.resolve();
		if (requests === 2) secondModelStarted.resolve();
		await release.promise;
	};
	const session = {
		model: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			await beginProvider();
			await finishTurn();
		},
		// This is the legacy event-persisted path: the entry is absent while the
		// provider is blocked, reproducing the concurrent redelivery window.
		promptCustomMessage: async (message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			attribution?: "agent" | "user";
		}) => {
			await beginProvider();
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution,
			);
			await finishTurn();
		},
		// The durable primitive appends and flushes before a provider can start.
		promptCustomMessagePersisted: async (message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			attribution?: "agent" | "user";
		}) => {
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution,
			);
			await manager.flush();
			await beginProvider();
			await finishTurn();
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages.at(-1),
		abort: async () => {},
		isAdvisorActive: () => false,
		getToolByName: (_name: string) => undefined,
		setWorkPoolYieldItems: async (_items: readonly unknown[]) => {},
		hasPendingAsyncWork: () => false,
		setIrcWakeTurnObserver: () => {},
		setIrcWakeTurnAdmission: (_next: unknown) => {},
		setIrcWakeTurnSettlement: (_next: unknown) => {},
		subscribeRunState: () => () => {},
	};
	return {
		session: session as unknown as AgentSession,
		modelRequests: () => requests,
		firstModelStarted: firstModelStarted.promise,
		secondModelStarted: secondModelStarted.promise,
		releaseModel: () => release.resolve(),
	};
}

describe("durable subagent follow-up delivery", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-durable-follow-up-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	it("inspects only the active branch when classifying keyed follow-ups", async () => {
		const appendedFile = path.join(tempDir.path(), "appended.jsonl");
		await writeTranscript(appendedFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
			sessionEntry("other-branch-answer", "delivery", { type: "message", message: assistantYield() }),
			sessionEntry("active-leaf", "delivery", { type: "custom", customType: "branch-marker" }),
		]);
		const answeredFile = path.join(tempDir.path(), "answered.jsonl");
		await writeTranscript(answeredFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
			sessionEntry("answer", "delivery", { type: "message", message: assistantYield() }),
		]);

		expect(await inspectDurableFollowUp(appendedFile, "resolution:r1")).toBe("appended");
		expect(await inspectDurableFollowUp(answeredFile, "resolution:r1")).toBe("answered");
	});

	it("recognizes upstream model-usage entries without mistaking them for corruption", async () => {
		const sessionFile = path.join(tempDir.path(), "model-usage.jsonl");
		await writeTranscript(sessionFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("usage", "init", {
				type: "model_usage",
				purpose: "subagent",
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage,
				stopReason: "stop",
			}),
		]);

		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("absent");
	});

	it("does not treat malformed transcript records as an absent delivery", async () => {
		const sessionFile = path.join(tempDir.path(), "malformed.jsonl");
		await Bun.write(sessionFile, "{not json}\n");

		await expect(inspectDurableFollowUp(sessionFile, "resolution:r1")).rejects.toThrow("malformed");
	});

	it("does not confuse another custom message's delivery key with a durable follow-up", async () => {
		const sessionFile = path.join(tempDir.path(), "custom-key-collision.jsonl");
		await writeTranscript(sessionFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("unrelated", "init", {
				type: "custom_message",
				customType: "another-extension",
				content: "Use port 8080.",
				display: true,
				details: { deliveryKey: "resolution:r1" },
			}),
		]);

		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("absent");
	});

	it("does not infer an absent delivery from parsed-invalid or unknown transcript entries", async () => {
		const parsedInvalidFile = path.join(tempDir.path(), "parsed-invalid.jsonl");
		await Bun.write(
			parsedInvalidFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
			})}\n{}\n`,
		);
		await expect(inspectDurableFollowUp(parsedInvalidFile, "resolution:r1")).rejects.toThrow("invalid");

		const unknownEntryFile = path.join(tempDir.path(), "unknown-entry.jsonl");
		await writeTranscript(unknownEntryFile, [sessionEntry("unknown", null, { type: "unknown-session-entry" })]);
		await expect(inspectDurableFollowUp(unknownEntryFile, "resolution:r1")).rejects.toThrow("invalid");
	});

	it("rejects a truncated assistant entry instead of treating it as a durable answer", async () => {
		const sessionFile = path.join(tempDir.path(), "truncated-assistant.jsonl");
		await writeTranscript(sessionFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
			sessionEntry("truncated-answer", "delivery", { type: "message", message: { role: "assistant" } }),
		]);

		await expect(inspectDurableFollowUp(sessionFile, "resolution:r1")).rejects.toThrow("invalid");
	});

	it("rejects malformed parent structure on an inactive transcript branch", async () => {
		const orphanFile = path.join(tempDir.path(), "off-branch-orphan.jsonl");
		await writeTranscript(orphanFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
			sessionEntry("orphan", "missing-parent", { type: "custom", customType: "off-branch" }),
			sessionEntry("active-leaf", "delivery", { type: "custom", customType: "active-branch" }),
		]);
		await expect(inspectDurableFollowUp(orphanFile, "resolution:r1")).rejects.toThrow("invalid");

		const cycleFile = path.join(tempDir.path(), "off-branch-cycle.jsonl");
		await writeTranscript(cycleFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
			sessionEntry("cycle-a", "cycle-b", { type: "custom", customType: "off-branch" }),
			sessionEntry("cycle-b", "cycle-a", { type: "custom", customType: "off-branch" }),
			sessionEntry("active-leaf", "delivery", { type: "custom", customType: "active-branch" }),
		]);
		await expect(inspectDurableFollowUp(cycleFile, "resolution:r1")).rejects.toThrow("invalid");
	});

	it("appends a follow-up once and never starts a second model turn for the same key", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendSessionInit({ systemPrompt: "test", task: "test", tools: ["yield"] });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const harness = createDurableSession(manager);
		const id = "DurableFollowUp";
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status: "idle",
			session: harness.session,
			sessionFile,
		});

		const options = { id, agent, deliveryKey: "resolution:r1", message: "Use port 8080." };
		const first = await runDurableSubagentFollowUpTurn(options);
		const second = await runDurableSubagentFollowUpTurn(options);

		expect(first.delivery).toBe("appended");
		expect(second.delivery).toBe("already-answered");
		expect(first.result?.exitCode).toBe(0);
		expect(harness.modelRequests()).toBe(1);
		const transcript = await Bun.file(sessionFile).text();
		expect(transcript.match(/resolution:r1/g)).toHaveLength(1);
		const delivered = transcript
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.find(entry => entry.type === "custom_message");
		expect(delivered).toMatchObject({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			attribution: "user",
			details: { deliveryKey: "resolution:r1" },
		});
		await manager.close();
	});

	it("does not append a follow-up whose caller cancelled before admission", async () => {
		const sessionFile = path.join(tempDir.path(), "cancelled-follow-up.jsonl");
		await writeTranscript(sessionFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
		]);
		AgentRegistry.global().register({
			id: "CancelledFollowUp",
			displayName: "CancelledFollowUp",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled before admission"));
		await expect(
			runDurableSubagentFollowUpTurn({
				id: "CancelledFollowUp",
				agent,
				deliveryKey: "resolution:r1",
				message: "Do not send.",
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled before admission");
		expect(await inspectDurableFollowUp(sessionFile, "resolution:r1")).toBe("absent");
	});

	it("leaves an already-appended follow-up untouched when no answer started", async () => {
		const sessionFile = path.join(tempDir.path(), "already-appended.jsonl");
		await writeTranscript(sessionFile, [
			sessionEntry("init", null, { type: "session_init", systemPrompt: "test", task: "test", tools: [] }),
			sessionEntry("delivery", "init", {
				type: "custom_message",
				customType: "subagent-durable-follow-up",
				content: "Use port 8080.",
				display: true,
				attribution: "user",
				details: { deliveryKey: "resolution:r1" },
			}),
		]);
		const id = "AlreadyAppended";
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
		});

		const result = await runDurableSubagentFollowUpTurn({
			id,
			agent,
			deliveryKey: "resolution:r1",
			message: "Use port 8080.",
		});

		expect(result).toEqual({ delivery: "already-appended" });
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
	});

	it("serializes concurrent same-key delivery before either provider turn can duplicate it", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendSessionInit({ systemPrompt: "test", task: "test", tools: ["yield"] });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const harness = createDeferredDurableSession(manager);
		const id = "ConcurrentDurableFollowUp";
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status: "idle",
			session: harness.session,
			sessionFile,
		});

		const options = { id, agent, deliveryKey: "resolution:r1", message: "Use port 8080." };
		const first = runDurableSubagentFollowUpTurn(options);
		await harness.firstModelStarted;
		const second = runDurableSubagentFollowUpTurn(options);
		const secondStartedBeforeFirstFinished = await Promise.race([
			harness.secondModelStarted.then(() => true),
			Bun.sleep(50).then(() => false),
		]);

		expect(secondStartedBeforeFirstFinished).toBe(false);
		harness.releaseModel();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult.delivery).toBe("appended");
		expect(secondResult.delivery).toBe("already-answered");
		expect(harness.modelRequests()).toBe(1);
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await manager.close();
	});

	it("continues to include revival time in ordinary follow-up result duration", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendSessionInit({ systemPrompt: "test", task: "test", tools: ["yield"] });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const harness = createDurableSession(manager);
		const id = "OrdinaryFollowUp";
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
		});
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			await Bun.sleep(30);
			return harness.session;
		});

		const result = await runSubagentFollowUpTurn({ id, agent, message: "Continue." });

		expect(result.durationMs).toBeGreaterThanOrEqual(25);
		await manager.close();
	});
});
