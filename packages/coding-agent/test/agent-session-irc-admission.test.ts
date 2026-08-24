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

async function createParkedSession(options?: { holdFirstProvider?: Promise<void> }): Promise<{
	session: AgentSession;
	providerStarts: () => number;
	firstProviderStarted: Promise<void>;
	tempDir: TempDir;
}> {
	const tempDir = TempDir.createSync("@pi-irc-admission-");
	const model = createMockModel({
		responses: [
			{ content: ["first wake"], stopReason: "stop" },
			{ content: ["second wake"], stopReason: "stop" },
			{ content: ["third wake"], stopReason: "stop" },
		],
	});
	let providerStarts = 0;
	const firstProviderStarted = Promise.withResolvers<void>();
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
		streamFn: async (...args) => {
			providerStarts++;
			if (providerStarts === 1) firstProviderStarted.resolve();
			if (providerStarts === 1) await options?.holdFirstProvider;
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
		firstProviderStarted: firstProviderStarted.promise,
		tempDir,
	};
}

function message(id: string, body: string): IrcMessage {
	return { id, from: "Main", to: "child", body, ts: Date.now() } as IrcMessage;
}

describe("AgentSession IRC wake admission", () => {
	it("does not start a Hub follow-up before admission and returns a refused record to pending", async () => {
		const { session, providerStarts, tempDir } = await createParkedSession();
		try {
			const gate = Promise.withResolvers<void>();
			session.setIrcWakeTurnAdmission(async () => gate.promise);

			expect(await session.deliverIrcMessage(message("irc-admission-first", "wait for me"))).toBe("woken");
			await Promise.resolve();
			expect(providerStarts()).toBe(0);

			gate.resolve();
			await session.waitForIdle();
			expect(providerStarts()).toBe(1);

			session.setIrcWakeTurnAdmission(async () => {
				throw new Error("parent turn still owns follow-up");
			});
			await session.deliverIrcMessage(message("irc-admission-refused", "keep this pending"));
			await Promise.resolve();
			expect(providerStarts()).toBe(1);
			expect(session.drainPendingIrcInboxMessages("child").map(record => record.body)).toEqual([
				"keep this pending",
			]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("defers a concurrently admitted wake until the active wake settles", async () => {
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, providerStarts, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		try {
			const observedBodies: string[] = [];
			const firstAdmissionEntered = Promise.withResolvers<void>();
			const secondAdmissionEntered = Promise.withResolvers<void>();
			const firstAdmissionRelease = Promise.withResolvers<void>();
			const secondAdmissionRelease = Promise.withResolvers<void>();
			let admissionCount = 0;
			session.setIrcWakeTurnObserver(records => {
				const body = records
					.map(record => String(record.details && Reflect.get(record.details, "message")))
					.join(",");
				observedBodies.push(body);
				return undefined;
			});
			session.setIrcWakeTurnAdmission(async () => {
				admissionCount++;
				if (admissionCount === 1) {
					firstAdmissionEntered.resolve();
					await firstAdmissionRelease.promise;
					return;
				}
				secondAdmissionEntered.resolve();
				await secondAdmissionRelease.promise;
			});

			await session.deliverIrcMessage(message("irc-concurrent-first", "first"));
			await firstAdmissionEntered.promise;
			await session.deliverIrcMessage(message("irc-concurrent-second", "second"));
			await secondAdmissionEntered.promise;
			firstAdmissionRelease.resolve();
			await firstProviderStarted;
			secondAdmissionRelease.resolve();
			await Bun.sleep(50);

			// Regression target: without the availability check, this starts a second observer/prompt and loses its batch.
			expect(providerStarts()).toBe(1);
			expect(observedBodies).toEqual(["first"]);

			firstProviderRelease.resolve();
			await Bun.sleep(50);
			expect(providerStarts()).toBe(2);
			expect(observedBodies).toEqual(["first"]);
			expect(
				session.agent.state.messages.flatMap(message =>
					message.role === "custom" && message.customType === "irc:incoming"
						? [String(message.details && Reflect.get(message.details, "message"))]
						: [],
				),
			).toEqual(["first", "second"]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("defers a wake whose lifecycle admission resolves after disposal", async () => {
		const { session, providerStarts, tempDir } = await createParkedSession();
		try {
			const admissionEntered = Promise.withResolvers<void>();
			const admissionRelease = Promise.withResolvers<void>();
			let observerStarts = 0;
			session.setIrcWakeTurnObserver(() => {
				observerStarts++;
				return undefined;
			});
			session.setIrcWakeTurnAdmission(async () => {
				admissionEntered.resolve();
				await admissionRelease.promise;
			});

			await session.deliverIrcMessage(message("irc-disposed", "do not start"));
			await admissionEntered.promise;
			session.beginDispose();
			admissionRelease.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// Regression target: a post-admission disposal must leave the record pending, not start a dead turn.
			expect(observerStarts).toBe(0);
			expect(providerStarts()).toBe(0);
			expect(session.drainPendingIrcInboxMessages("child").map(record => record.body)).toEqual(["do not start"]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});
});
