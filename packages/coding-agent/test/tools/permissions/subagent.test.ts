import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentRegistry } from "../../../src/registry/agent-registry";
import type { EngineDecision } from "../../../src/tools/permissions/engine";
import {
	abortPendingForSession,
	findRootSessionId,
	type PendingApproval,
	parkApproval,
	pendingApprovalsForSession,
	registerPermissionHandler,
	unregisterPermissionHandler,
} from "../../../src/tools/permissions/subagent";

// Registry ids used by this file's fake session tree. The AgentRegistry is a
// process-global singleton (the same instance the Agent Hub and
// createAgentSession use), so every ref is registered and unregistered around
// each test and ids are namespaced to avoid colliding with real agents.
const ROOT_ID = "test-subagent-root";
const PARENT_ID = "test-subagent-parent";
const SUB_ID = "test-subagent-leaf";
const UNRELATED_ID = "test-subagent-unrelated";
const FAKE_IDS = [ROOT_ID, PARENT_ID, SUB_ID, UNRELATED_ID];

function fakeDecision(): EngineDecision {
	return { policy: "prompt", tier: "exec", source: "posture", override: false, reason: "no matching rule" };
}

function makePending(sessionId: string, toolName = "bash"): PendingApproval {
	return {
		key: `${toolName}:${sessionId}:call-1`,
		sessionId,
		toolName,
		args: { command: "echo hi" },
		decision: fakeDecision(),
		resolve: () => {},
		reject: () => {},
	};
}

function registerRef(id: string, parentId?: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId,
		session: null,
		status: "idle",
	});
}

afterEach(() => {
	for (const id of FAKE_IDS) {
		unregisterPermissionHandler(id);
		abortPendingForSession(id);
		if (AgentRegistry.global().get(id)) AgentRegistry.global().unregister(id);
	}
});

describe("findRootSessionId", () => {
	it("walks the parentId chain to the root", () => {
		registerRef(ROOT_ID);
		registerRef(PARENT_ID, ROOT_ID);
		registerRef(SUB_ID, PARENT_ID);
		expect(findRootSessionId(SUB_ID)).toBe(ROOT_ID);
		expect(findRootSessionId(PARENT_ID)).toBe(ROOT_ID);
		expect(findRootSessionId(ROOT_ID)).toBe(ROOT_ID);
	});

	it("falls back to the session id itself when no parent exists", () => {
		registerRef(UNRELATED_ID);
		expect(findRootSessionId(UNRELATED_ID)).toBe(UNRELATED_ID);
		expect(findRootSessionId("unknown-session")).toBe("unknown-session");
	});

	it("terminates on a cyclic parent chain", () => {
		registerRef(PARENT_ID, SUB_ID);
		registerRef(SUB_ID, PARENT_ID);
		expect(typeof findRootSessionId(SUB_ID)).toBe("string");
	});
});

describe("parkApproval", () => {
	it("parks a subagent call and bubbles it to the root session's handler", async () => {
		registerRef(ROOT_ID);
		registerRef(PARENT_ID, ROOT_ID);
		registerRef(SUB_ID, PARENT_ID);
		const handler = vi.fn(async (_pending: PendingApproval) => ({ policy: "allow" as const }));
		registerPermissionHandler(ROOT_ID, handler);

		const pending = makePending(SUB_ID);
		const parked = parkApproval(pending);
		// The pending is registered synchronously; the handler answers asynchronously.
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([pending]);
		await expect(parked).resolves.toEqual({ policy: "allow" });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toMatchObject({
			key: pending.key,
			sessionId: SUB_ID,
			toolName: "bash",
			args: { command: "echo hi" },
			decision: pending.decision,
		});
		// Settled pendings are removed from the registry.
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});

	it("surfaces a deny resolution from the handler", async () => {
		registerRef(ROOT_ID);
		registerRef(SUB_ID, ROOT_ID);
		registerPermissionHandler(ROOT_ID, async () => ({ policy: "deny" as const }));
		await expect(parkApproval(makePending(SUB_ID))).resolves.toEqual({ policy: "deny" });
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});

	it("fails closed with the no-UI error when no handler exists up the chain", async () => {
		registerRef(ROOT_ID);
		registerRef(SUB_ID, ROOT_ID);
		await expect(parkApproval(makePending(SUB_ID))).rejects.toThrow(
			'Tool "bash" requires approval but no interactive UI available.',
		);
		// Nothing is parked when the call failed closed.
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});

	it("fails closed after the root handler is unregistered", async () => {
		registerRef(ROOT_ID);
		registerRef(SUB_ID, ROOT_ID);
		registerPermissionHandler(ROOT_ID, async () => ({ policy: "allow" as const }));
		unregisterPermissionHandler(ROOT_ID);
		await expect(parkApproval(makePending(SUB_ID))).rejects.toThrow(
			/requires approval but no interactive UI available/,
		);
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});

	it("abortPendingForSession rejects the parked promise and clears the registry", async () => {
		registerRef(ROOT_ID);
		registerRef(SUB_ID, ROOT_ID);
		// A handler that never answers, so the call stays parked.
		const never = Promise.withResolvers<{ policy: "allow" | "deny" }>();
		registerPermissionHandler(ROOT_ID, () => never.promise);

		const parked = parkApproval(makePending(SUB_ID));
		expect(pendingApprovalsForSession(SUB_ID)).toHaveLength(1);
		abortPendingForSession(SUB_ID);
		await expect(parked).rejects.toThrow(/aborted/);
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});

	it("pendingApprovalsForSession scopes pendings to their owning session", async () => {
		registerRef(ROOT_ID);
		registerRef(SUB_ID, ROOT_ID);
		const never = Promise.withResolvers<{ policy: "allow" | "deny" }>();
		registerPermissionHandler(ROOT_ID, () => never.promise);

		const first = makePending(SUB_ID, "bash");
		const second = makePending(SUB_ID, "read");
		const parkedFirst = parkApproval(first);
		const parkedSecond = parkApproval(second);
		expect(pendingApprovalsForSession(SUB_ID).map(p => p.key)).toEqual([first.key, second.key]);
		// Pendings parked by a subagent are not visible under the root id.
		expect(pendingApprovalsForSession(ROOT_ID)).toEqual([]);
		// Observe both parked promises (handlers attached before abort) so the
		// abort rejections are handled, not reported as unhandled.
		const outcomes = [parkedFirst, parkedSecond].map(p =>
			p.then(
				() => null,
				(err: unknown) => err,
			),
		);
		abortPendingForSession(SUB_ID);
		for (const outcome of outcomes) {
			await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining("aborted") });
		}
		expect(pendingApprovalsForSession(SUB_ID)).toEqual([]);
	});
});
