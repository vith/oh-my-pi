import { afterAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");
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
function ircRecordBody(record: object): string {
	const details: unknown = Reflect.get(record, "details");
	return String(details && Reflect.get(details as object, "message"));
}

function deliveredIrcBodies(session: AgentSession): string[] {
	return session.agent.state.messages.flatMap(message =>
		message.role === "custom" && message.customType === "irc:incoming" ? [ircRecordBody(message)] : [],
	);
}

describe("AgentSession IRC wake admission", () => {
	it("delivers refused batches with a later accepted wake in arrival order", async () => {
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, providerStarts, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		try {
			const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			let admissionCount = 0;
			session.setIrcWakeTurnAdmission(async () => {
				const index = admissionCount++;
				entered[index]?.resolve();
				await releases[index]?.promise;
				if (index < 2) throw new Error(`refuse-${index}`);
			});

			await session.deliverIrcMessage(message("irc-refused-first", "refused first"));
			await entered[0]?.promise;
			await session.deliverIrcMessage(message("irc-refused-second", "refused second"));
			await entered[1]?.promise;
			await session.deliverIrcMessage(message("irc-refused-trigger", "accepted trigger"));
			await entered[2]?.promise;

			// Resolve the later refusal first: completion order must not reorder the pending IRC records.
			releases[1]?.resolve();
			releases[0]?.resolve();
			releases[2]?.resolve();
			await firstProviderStarted;
			expect(providerStarts()).toBe(1);
			firstProviderRelease.resolve();
			await Bun.sleep(50);

			expect(deliveredIrcBodies(session)).toEqual(["refused first", "refused second", "accepted trigger"]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("keeps three admitted wake batches in arrival order when later admissions resolve first", async () => {
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, providerStarts, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		try {
			const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			let admissionCount = 0;
			session.setIrcWakeTurnAdmission(async () => {
				const index = admissionCount++;
				entered[index]?.resolve();
				await releases[index]?.promise;
			});

			await session.deliverIrcMessage(message("irc-order-first", "first"));
			await entered[0]?.promise;
			await session.deliverIrcMessage(message("irc-order-second", "second"));
			await entered[1]?.promise;
			await session.deliverIrcMessage(message("irc-order-third", "third"));
			await entered[2]?.promise;

			// R3 and R2 resolve first while R1 is still pending; all records still belong to their arrival order.
			releases[2]?.resolve();
			releases[1]?.resolve();
			releases[0]?.resolve();
			await firstProviderStarted;
			expect(providerStarts()).toBe(1);
			firstProviderRelease.resolve();
			await Bun.sleep(50);

			expect(deliveredIrcBodies(session)).toEqual(["first", "second", "third"]);
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
				const body = records.map(record => ircRecordBody(record)).join(",");
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
			expect(observedBodies).toEqual(["first", "second"]);
			expect(
				session.agent.state.messages.flatMap(message =>
					message.role === "custom" && message.customType === "irc:incoming" ? [ircRecordBody(message)] : [],
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

	it("settles an admitted wake after its observer even when the observer finish fails", async () => {
		const { session, tempDir } = await createParkedSession();
		try {
			const events: string[] = [];
			const settled = Promise.withResolvers<unknown>();
			vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("wake provider failed"));
			session.setIrcWakeTurnObserver(() => {
				events.push("observer-start");
				return error => {
					events.push(`observer-finish:${error instanceof Error ? error.message : "none"}`);
					throw new Error("observer finish failed");
				};
			});
			session.setIrcWakeTurnSettlement((_records, error) => {
				events.push(`settlement:${error instanceof Error ? error.message : "none"}`);
				settled.resolve(error);
			});

			await session.deliverIrcMessage(message("irc-settlement-error", "settle after failure"));
			await expect(settled.promise).resolves.toBeInstanceOf(Error);
			expect(events).toEqual([
				"observer-start",
				"observer-finish:wake provider failed",
				"settlement:wake provider failed",
			]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("never settles a batch whose lifecycle admission refused the wake", async () => {
		const { session, providerStarts, tempDir } = await createParkedSession();
		try {
			const settlements: string[] = [];
			session.setIrcWakeTurnAdmission(async () => {
				throw new Error("durable admission refused");
			});
			session.setIrcWakeTurnSettlement(records => {
				settlements.push(String(records.length));
			});

			await session.deliverIrcMessage(message("irc-refused-settlement", "do not settle"));
			await Bun.sleep(20);
			expect(providerStarts()).toBe(0);
			expect(settlements).toEqual([]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("does not settle an admitted wake after direct disposal while its provider is in flight", async () => {
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		try {
			const settlements: string[] = [];
			session.setIrcWakeTurnSettlement(records => {
				settlements.push(String(records[0] && ircRecordBody(records[0])));
			});

			await session.deliverIrcMessage(message("irc-dispose-settlement", "do not settle after dispose"));
			await firstProviderStarted;
			session.beginDispose();
			firstProviderRelease.resolve();
			await session.waitForIdle();
			await Bun.sleep(20);

			expect(settlements).toEqual([]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("does not settle an admitted wake after lifecycle tombstone release while its provider is in flight", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const ref = registry.register({
			id: "tombstone-settlement-child",
			displayName: "child",
			kind: "sub",
			session,
			sessionFile: `${tempDir.path()}/tombstone-settlement-child.jsonl`,
			status: "idle",
		});
		lifecycle.adopt(ref.id, { idleTtlMs: 0 }, ref);
		try {
			const settlements: string[] = [];
			lifecycle.setFollowUpSettlement(ref.id, records => {
				settlements.push(String(records[0] && ircRecordBody(records[0])));
			});

			await session.deliverIrcMessage(message("irc-tombstone-settlement", "do not settle after tombstone"));
			await firstProviderStarted;
			const tombstone = lifecycle.release(ref.id, ref, { tombstone: true });
			firstProviderRelease.resolve();
			await tombstone;
			await Bun.sleep(20);

			expect(settlements).toEqual([]);
		} finally {
			await lifecycle.dispose();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			await session.dispose();
			tempDir.removeSync();
		}
	});

	it("does not deliver an old admitted wake to a replacement settlement policy", async () => {
		const firstProviderRelease = Promise.withResolvers<void>();
		const { session, firstProviderStarted, tempDir } = await createParkedSession({
			holdFirstProvider: firstProviderRelease.promise,
		});
		try {
			const oldSettlements: string[] = [];
			const currentSettlements: string[] = [];
			session.setIrcWakeTurnSettlement(records => {
				oldSettlements.push(String(records[0] && ircRecordBody(records[0])));
			});
			await session.deliverIrcMessage(message("irc-policy-old", "old policy wake"));
			await firstProviderStarted;
			session.setIrcWakeTurnSettlement(records => {
				currentSettlements.push(String(records[0] && ircRecordBody(records[0])));
			});
			firstProviderRelease.resolve();
			await session.waitForIdle();
			await Bun.sleep(20);

			expect(oldSettlements).toEqual([]);
			expect(currentSettlements).toEqual([]);

			await session.deliverIrcMessage(message("irc-policy-current", "current policy wake"));
			await session.waitForIdle();
			await Bun.sleep(20);
			expect(currentSettlements).toEqual(["current policy wake"]);
		} finally {
			await session.dispose();
			tempDir.removeSync();
		}
	});
});
