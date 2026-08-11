/**
 * Parked subagent approvals (spec §6): a headless subagent's pending tool call
 * parks on a promise and bubbles to the root session's permission handler,
 * where the user answers in the focused subagent view. Without a handler
 * anywhere up the session tree the call fails closed with the legacy
 * "requires approval but no interactive UI available" error, preserving
 * print/RPC/ACP behavior.
 *
 * The parked promise is owned by {@link parkApproval}: it registers the
 * pending, wires the handler's settlement (or a direct answer through
 * `pending.resolve`) into the promise, and returns it — so
 * {@link abortPendingForSession} can reject every parked promise of an
 * aborted session with no leaks.
 */

import { AgentRegistry } from "../../registry/agent-registry";
import type { EngineDecision } from "./engine";
import type { PermissionRule } from "./rules";

/** Custom transcript entry type for a parked subagent approval (Task 14). */
export const PERMISSION_PENDING_TYPE = "permission-pending";

export interface PendingApproval {
	/** Unique per tool call (`toolName:toolCallId`). */
	key: string;
	/** The session whose tool call is parked (the subagent session). */
	sessionId: string;
	/** Display name of the parked agent, when known. */
	agentId?: string;
	toolName: string;
	args: unknown;
	decision: EngineDecision;
	/** Settles the parked call with the user's answer (Task 14 focused view). */
	resolve: (resolution: { policy: "allow" | "deny"; remembered?: Omit<PermissionRule, "layer"> }) => void;
	/** Rejects the parked call (abort/error paths). */
	reject: (err: Error) => void;
}

type PermissionHandler = (pending: PendingApproval) => Promise<{ policy: "allow" | "deny" }>;

/** Handlers keyed by the root session id they serve (interactive mode installs one). */
const handlers = new Map<string, PermissionHandler>();
/** Parked pendings keyed by the session that parked them (pending.sessionId). */
const pendingBySession = new Map<string, PendingApproval[]>();

/** Install the interactive answering handler for a (root) session. */
export function registerPermissionHandler(sessionId: string, handler: PermissionHandler): void {
	handlers.set(sessionId, handler);
}

export function unregisterPermissionHandler(sessionId: string): void {
	handlers.delete(sessionId);
}

/**
 * Walk the AgentRegistry parentId chain from `sessionId` to the root session.
 * The pending call carries the session-manager id (the wrapper reads
 * `context.sessionManager.getSessionId()`), while the registry is keyed by
 * agent id — so the starting ref is resolved by exact id first, then by the
 * live attached session's manager id (`createAgentSession` pre-registers every
 * agent with `parentId`). The returned root is the root session's
 * session-manager id when its session is live (the namespace permission
 * handlers are registered in), else its ref id. Sessions without a parent —
 * or unknown ids — fall back to the id itself. Returns null only for an empty
 * id (no session manager in the context).
 */
export function findRootSessionId(sessionId: string): string | null {
	if (!sessionId) return null;
	const registry = AgentRegistry.global();
	const start =
		registry.get(sessionId) ?? registry.list().find(ref => ref.session?.sessionManager.getSessionId() === sessionId);
	const visited = new Set<string>();
	let current = start?.id ?? sessionId;
	while (!visited.has(current)) {
		visited.add(current);
		const ref = registry.get(current);
		if (!ref?.parentId) {
			return ref?.session?.sessionManager.getSessionId() ?? ref?.id ?? sessionId;
		}
		current = ref.parentId;
	}
	return registry.get(current)?.session?.sessionManager.getSessionId() ?? current;
}

/**
 * Legacy fail-closed error, byte-identical to the pre-Task-13 no-UI branch so
 * print/RPC/ACP behavior and its tests are preserved.
 */
function noInteractiveUIError(toolName: string): Error {
	return new Error(
		`Tool "${toolName}" requires approval but no interactive UI available.\n` +
			`Options:\n` +
			`  1. Set tools.approvalMode: yolo in /settings\n` +
			`  2. Add tools.approval.${toolName}: allow to config\n` +
			`  3. Use an interactive UI to approve the tool call`,
	);
}

function addPending(pending: PendingApproval): void {
	const list = pendingBySession.get(pending.sessionId);
	if (list) {
		list.push(pending);
	} else {
		pendingBySession.set(pending.sessionId, [pending]);
	}
}

function removePending(pending: PendingApproval): void {
	const list = pendingBySession.get(pending.sessionId);
	if (!list) return;
	const index = list.indexOf(pending);
	if (index >= 0) list.splice(index, 1);
	if (list.length === 0) pendingBySession.delete(pending.sessionId);
}

/** Parked pendings of one session, for the focused-view UI (Task 14). */
export function pendingApprovalsForSession(sessionId: string): PendingApproval[] {
	return [...(pendingBySession.get(sessionId) ?? [])];
}

/**
 * Reject every parked promise owned by an aborted session and drop the
 * session's pendings — no parked call may outlive its agent (spec §6.3).
 */
export function abortPendingForSession(sessionId: string): void {
	const list = pendingBySession.get(sessionId);
	if (!list) return;
	pendingBySession.delete(sessionId);
	for (const pending of list) {
		pending.reject(
			new Error(`Approval for tool "${pending.toolName}" aborted: session "${sessionId}" was terminated`),
		);
	}
}

/**
 * Park a pending approval on the root session's handler. Throws the legacy
 * no-UI error (fail-closed) when no handler is registered anywhere up the
 * session tree. The returned promise settles through the pending's
 * resolve/reject, so an answering UI (Task 14) and abort paths both settle
 * the parked call.
 */
export async function parkApproval(pending: PendingApproval): Promise<{ policy: "allow" | "deny" }> {
	const rootId = findRootSessionId(pending.sessionId);
	const handler = rootId === null ? undefined : handlers.get(rootId);
	if (!handler) throw noInteractiveUIError(pending.toolName);
	const { promise, resolve, reject } = Promise.withResolvers<{ policy: "allow" | "deny" }>();
	pending.resolve = resolve;
	pending.reject = reject;
	addPending(pending);
	void handler(pending).then(
		(resolution: { policy: "allow" | "deny" }) => {
			removePending(pending);
			resolve(resolution);
		},
		(err: unknown) => {
			removePending(pending);
			reject(err instanceof Error ? err : new Error(String(err)));
		},
	);
	return promise;
}
