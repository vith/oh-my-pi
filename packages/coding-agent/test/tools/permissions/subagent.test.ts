import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

/** Minimal live-session double exposing just the session-manager id. */
function fakeSession(sessionId: string): AgentSession {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as AgentSession;
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

	it("resolves a session-manager id onto the registry via the attached session and returns the root's session id", () => {
		// The wrapper carries the session-manager id, while registry refs are
		// keyed by agent id — the walk must bridge the two namespaces.
		const rootSessionId = "sess-root-abc";
		const subSessionId = "sess-sub-xyz";
		AgentRegistry.global().register({
			id: ROOT_ID,
			displayName: ROOT_ID,
			kind: "main",
			session: fakeSession(rootSessionId),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: SUB_ID,
			displayName: SUB_ID,
			kind: "sub",
			parentId: ROOT_ID,
			session: fakeSession(subSessionId),
			status: "running",
		});
		expect(findRootSessionId(subSessionId)).toBe(rootSessionId);
		expect(findRootSessionId(rootSessionId)).toBe(rootSessionId);
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

describe("wrapper park integration", () => {
	// The real approval gate (ExtensionToolWrapper) parked against a live
	// headless session: the pending carries the session-manager id, and the
	// root walk must bridge it onto the registry ref (keyed by agent id) so
	// the registered handler answers. A handler resolving allow must let the
	// call execute — the park branch is terminal and never falls into the
	// no-op dialog — and deny must surface the standard denied error.
	const BASE_SETTINGS = {
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	} as const;
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let sessionId: string;

	function emptyWorkspaceTree(cwd: string) {
		return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
	}

	function approvalSettings(extraSettings: Record<string, unknown> = {}): Settings {
		return Settings.isolated({ ...BASE_SETTINGS, ...extraSettings });
	}

	function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
		const blocks = result.content ?? [];
		for (const block of blocks) {
			if (block.type === "text" && typeof block.text === "string") return block.text;
		}
		return "";
	}

	function bashTool(): AgentTool {
		const tool = session.getToolByName("bash");
		if (!tool) throw new Error("Expected bash tool");
		return tool;
	}

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-park-"));
		const cwd = path.join(tempDir, "cwd");
		await fs.mkdir(cwd, { recursive: true });
		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		sessionId = sessionManager.getSessionId();
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});
		session = created.session;
	});

	afterEach(() => {
		unregisterPermissionHandler(sessionId);
		abortPendingForSession(sessionId);
	});

	afterAll(async () => {
		await session.dispose();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("executes the tool when the parked approval resolves allow", async () => {
		registerPermissionHandler(sessionId, async () => ({ policy: "allow" as const }));
		const result = await bashTool().execute("park-allow", { command: "echo park-allow-ok" }, undefined, undefined, {
			settings: approvalSettings({ "tools.approvalMode": "always-ask" }),
			sessionManager,
		} as unknown as AgentToolContext);
		expect(textOf(result)).toContain("park-allow-ok");
	});

	it("throws the standard denied error when the parked approval resolves deny", async () => {
		registerPermissionHandler(sessionId, async () => ({ policy: "deny" as const }));
		await expect(
			bashTool().execute("park-deny", { command: "echo never" }, undefined, undefined, {
				settings: approvalSettings({ "tools.approvalMode": "always-ask" }),
				sessionManager,
			} as unknown as AgentToolContext),
		).rejects.toThrow("Tool call denied by user: bash");
	});

	it("fails closed with the legacy no-UI error when no handler is registered", async () => {
		await expect(
			bashTool().execute("park-nohandler", { command: "echo never" }, undefined, undefined, {
				settings: approvalSettings({ "tools.approvalMode": "always-ask" }),
				sessionManager,
			} as unknown as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});
});
