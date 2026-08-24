import { afterAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("mock", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

async function createParkedSession(): Promise<{
	session: AgentSession;
	providerStarts: () => number;
	tempDir: TempDir;
}> {
	const tempDir = TempDir.createSync("@pi-irc-admission-");
	const model = createMockModel({
		responses: [
			{ content: ["first wake"], stopReason: "stop" },
			{ content: ["second wake"], stopReason: "stop" },
		],
	});
	let providerStarts = 0;
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: (...args) => {
			providerStarts++;
			return model.stream(...args);
		},
	});
	return {
		session: new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		}),
		providerStarts: () => providerStarts,
		tempDir,
	};
}

describe("AgentSession IRC wake admission", () => {
	it("does not start a Hub follow-up before admission and retries a refused record once", async () => {
		const { session, providerStarts, tempDir } = await createParkedSession();
		try {
			const wakeBodies: string[][] = [];
			const replayed = Promise.withResolvers<void>();
			session.setIrcWakeTurnObserver(records => {
				wakeBodies.push(
					records.map(record =>
						typeof record.content === "string" ? record.content : JSON.stringify(record.content),
					),
				);
				if (wakeBodies.length === 3) replayed.resolve();
				return undefined;
			});
			const gate = Promise.withResolvers<void>();
			session.setIrcWakeTurnAdmission(async () => gate.promise);

			const first = await session.deliverIrcMessage({
				id: "irc-admission-first",
				from: "Main",
				to: "child",
				body: "wait for me",
				ts: Date.now(),
			} as IrcMessage);
			expect(first).toBe("woken");
			await Promise.resolve();
			expect(providerStarts()).toBe(0);

			gate.resolve();
			await session.waitForIdle();
			expect(providerStarts()).toBe(1);

			session.setIrcWakeTurnAdmission(async () => {
				throw new Error("parent turn still owns follow-up");
			});
			await session.deliverIrcMessage({
				id: "irc-admission-refused",
				from: "Main",
				to: "child",
				body: "keep this pending",
				ts: Date.now(),
			} as IrcMessage);
			await Promise.resolve();
			expect(providerStarts()).toBe(1);

			session.setIrcWakeTurnAdmission(undefined);
			await session.deliverIrcMessage({
				id: "irc-admission-later",
				from: "Main",
				to: "child",
				body: "wake again",
				ts: Date.now(),
			} as IrcMessage);
			await replayed.promise;
			await session.waitForIdle();

			// The later wake starts one new provider turn; then the refused record is re-drained exactly once.
			expect(providerStarts()).toBe(2);
			expect(wakeBodies).toHaveLength(3);
			expect(wakeBodies.map(records => records.join("\n"))).toEqual(
			expect.arrayContaining([
				expect.stringContaining("wait for me"),
				expect.stringContaining("wake again"),
				expect.stringContaining("keep this pending"),
			]),
		);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});
});
