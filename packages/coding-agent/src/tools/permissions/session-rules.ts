/**
 * In-memory session rule layer ("Allow for this session", demo bug 8).
 *
 * Rules added here permit matching calls for the rest of the process's
 * session without writing anything to disk: no permission file changes, no
 * migration surface, nothing survives a restart. The store is keyed by
 * session id (the wrapper and the interactive-mode engine-context factory
 * both resolve it from the session manager); contexts without a session
 * (headless/tests) fall back to the cwd, so dialog-driven session rules
 * still work in-process.
 */

import type { EngineContext } from "./engine";
import type { PermissionRule } from "./rules";

const store = new Map<string, PermissionRule[]>();

/** Upsert a session-layer rule (by id) into the store. */
export function addSessionRule(key: string, rule: Omit<PermissionRule, "layer">): PermissionRule {
	const entry: PermissionRule = { ...rule, layer: "session" };
	const existing = store.get(key) ?? [];
	const index = existing.findIndex(candidate => candidate.id === entry.id);
	if (index >= 0) {
		existing[index] = entry;
	} else {
		existing.push(entry);
	}
	store.set(key, existing);
	return entry;
}

/** The session-layer rules for a store key (empty when none were added). */
export function sessionRules(key: string): readonly PermissionRule[] {
	return store.get(key) ?? [];
}

/**
 * Store key for an engine context: the session id when one exists, else the
 * cwd (headless flows and tests have no session manager).
 */
export function sessionRuleKey(ctx: EngineContext): string {
	return ctx.sessionId ?? ctx.cwd;
}

/** Drop one or all session layers (tests and session teardown). */
export function clearSessionRules(key?: string): void {
	if (key === undefined) {
		store.clear();
	} else {
		store.delete(key);
	}
}
