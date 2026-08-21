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
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages.at(-1),
		abort: async () => {},
		hasPendingAsyncWork: () => false,
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	return { session: session as unknown as AgentSession, modelRequests: () => requests };
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

	it("does not treat malformed transcript records as an absent delivery", async () => {
		const sessionFile = path.join(tempDir.path(), "malformed.jsonl");
		await Bun.write(sessionFile, "{not json}\n");

		await expect(inspectDurableFollowUp(sessionFile, "resolution:r1")).rejects.toThrow("malformed");
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
