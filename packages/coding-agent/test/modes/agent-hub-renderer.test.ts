/**
 * Task 15 (spec §6.3): the Agent Hub roster marks rows whose subagent tool
 * call is parked awaiting approval with the ⏳ glyph and "awaiting approval"
 * status text, so the user knows where to go answer (the focused-view notice
 * in permission-pending.ts points there too). Display-only: no interaction
 * changes, no registry mutation.
 *
 * The pending registry is seeded through the real parkApproval flow (the
 * same module-level registry the renderer reads), not a mock.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { pendingApprovalCount, statusGlyph, statusText } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EngineDecision } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	abortPendingForSession,
	type PendingApproval,
	parkApproval,
	pendingApprovalsForSession,
	registerPermissionHandler,
	unregisterPermissionHandler,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/subagent";

const SESSION_ID = "test-hub-renderer-parked";

function fakeDecision(): EngineDecision {
	return { policy: "prompt", tier: "exec", source: "posture", override: false, reason: "no matching rule" };
}

function makePending(sessionId: string): PendingApproval {
	return {
		key: `bash:${sessionId}:call-1`,
		sessionId,
		toolName: "bash",
		args: { command: "echo hi" },
		decision: fakeDecision(),
		resolve: () => {},
		reject: () => {},
	};
}

/** Minimal live-session double exposing just the session-manager id. */
function fakeSession(sessionId: string): AgentSession {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as AgentSession;
}

function refWithSession(session: AgentSession | null, status: AgentRef["status"] = "running"): AgentRef {
	return {
		id: "test-hub-renderer-agent",
		displayName: "Test agent",
		kind: "sub",
		parentId: "Main",
		status,
		session,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
	};
}

/** Park one approval for SESSION_ID on a never-settling handler. */
function parkOne(): void {
	registerPermissionHandler(SESSION_ID, () => new Promise(() => {}));
	const parked = parkApproval(makePending(SESSION_ID));
	parked.catch(() => {}); // afterEach aborts it; swallow the rejection
}

afterEach(() => {
	unregisterPermissionHandler(SESSION_ID);
	abortPendingForSession(SESSION_ID);
});

beforeAll(async () => {
	await initTheme();
});

describe("Agent Hub awaiting-approval marker", () => {
	it("renders the ⏳ glyph and awaiting-approval text for a ref with parked approvals", () => {
		parkOne();
		expect(pendingApprovalsForSession(SESSION_ID)).toHaveLength(1);
		const ref = refWithSession(fakeSession(SESSION_ID), "running");

		expect(pendingApprovalCount(ref)).toBe(1);
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).toContain("⏳");
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).not.toContain("⟳");
		expect(statusText(ref.status, ref.status, pendingApprovalCount(ref))).toContain("awaiting approval");
	});

	it("overrides the marker for every status, not only running", () => {
		parkOne();
		const ref = refWithSession(fakeSession(SESSION_ID), "parked");

		expect(pendingApprovalCount(ref)).toBe(1);
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).toContain("⏳");
		expect(statusText(ref.status, ref.status, pendingApprovalCount(ref))).toContain("awaiting approval");
	});

	it("keeps the plain status glyph/text when nothing is parked", () => {
		const ref = refWithSession(fakeSession(SESSION_ID), "running");

		expect(pendingApprovalCount(ref)).toBe(0);
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).toContain("⟳");
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).not.toContain("⏳");
		expect(statusText(ref.status, ref.status, pendingApprovalCount(ref))).toContain("running");
		expect(statusText(ref.status, ref.status, pendingApprovalCount(ref))).not.toContain("awaiting approval");
	});

	it("never marks a detached ref (no live session)", () => {
		parkOne();
		const ref = refWithSession(null, "parked");

		expect(pendingApprovalCount(ref)).toBe(0);
		expect(statusGlyph(ref.status, pendingApprovalCount(ref))).not.toContain("⏳");
	});
});
