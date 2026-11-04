import { describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IdleMaintenance, type IdleMaintenanceSession } from "@oh-my-pi/pi-coding-agent/session/idle-maintenance";

function recapHarness() {
	const requests: Array<{ signal: AbortSignal | undefined; resolve: (value: { replyText: string }) => void }> = [];
	const recordRecap = vi.fn();
	const onRecap = vi.fn();
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		settings: Settings.isolated({ recap: { enabled: false } }),
		model: createMockModel(),
		messages: [{ role: "user", content: "Summarize this conversation", timestamp: 1 }],
		isStreaming: true,
		isCompacting: false,
		isSessionTransitioning: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		sessionManager: { recordRecap, getSessionName: () => "Recap regression" },
		getGoalModeState: () => undefined,
		getTodoPhases: () => [],
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		waitForIdle: async () => {},
		hasPendingAsyncWork: () => false,
		runEphemeralTurn: ({ signal }: { signal?: AbortSignal }) => {
			const pending = Promise.withResolvers<{ replyText: string }>();
			requests.push({ signal, resolve: pending.resolve });
			return pending.promise;
		},
	} as unknown as IdleMaintenanceSession;
	const maintenance = new IdleMaintenance(session, { isBlocked: () => true, onRecap });
	return { maintenance, requests, recordRecap, onRecap, emit: (event: AgentSessionEvent) => listener?.(event) };
}

describe("requested session recap", () => {
	it("ignores idle settings, drafts and active-turn gates and journals the full reply", async () => {
		const h = recapHarness();
		try {
			const run = h.maintenance.runRecap();
			h.requests[0]!.resolve({ replyText: "A requested recap\nwith details" });
			await run;
			expect(h.recordRecap).toHaveBeenCalledWith("A requested recap\nwith details");
			expect(h.onRecap).toHaveBeenCalledWith("A requested recap\nwith details");
		} finally {
			h.maintenance.dispose();
		}
	});

	it("supersedes an earlier request even when its provider ignores cancellation", async () => {
		const h = recapHarness();
		try {
			const first = h.maintenance.runRecap();
			const second = h.maintenance.runRecap();
			expect(h.requests[0]!.signal?.aborted).toBe(true);
			h.requests[1]!.resolve({ replyText: "Current recap" });
			await second;
			h.requests[0]!.resolve({ replyText: "Stale recap" });
			await first;
			expect(h.recordRecap.mock.calls).toEqual([["Current recap"]]);
			expect(h.onRecap.mock.calls).toEqual([["Current recap"]]);
		} finally {
			h.maintenance.dispose();
		}
	});

	it("survives the active turn settling but drops a request invalidated by a transition", async () => {
		const h = recapHarness();
		try {
			const first = h.maintenance.runRecap();
			h.emit({ type: "agent_end", messages: [] });
			expect(h.requests[0]!.signal?.aborted).toBe(false);
			h.requests[0]!.resolve({ replyText: "Still requested" });
			await first;
			const second = h.maintenance.runRecap();
			h.maintenance.invalidate();
			h.requests[1]!.resolve({ replyText: "Outgoing transcript" });
			await second;
			expect(h.recordRecap.mock.calls).toEqual([["Still requested"]]);
			expect(h.onRecap.mock.calls).toEqual([["Still requested"]]);
		} finally {
			h.maintenance.dispose();
		}
	});
});
