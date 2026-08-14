import { afterEach, describe, expect, it } from "bun:test";
import type { PermissionRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import {
	addSessionRule,
	clearSessionRules,
	sessionRuleKey,
	sessionRules,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/session-rules";

const rule = (id: string): Omit<PermissionRule, "layer"> => ({
	id,
	tool: "bash",
	match: { command: "echo hi" },
	action: "allow",
});

describe("session rules store (bug 8)", () => {
	afterEach(() => clearSessionRules());

	it("adds a rule with the session layer and reads it back", () => {
		addSessionRule("s1", rule("r1"));
		expect(sessionRules("s1")).toEqual([
			{
				id: "r1",
				tool: "bash",
				match: { command: "echo hi" },
				action: "allow",
				layer: "session",
			},
		]);
	});

	it("upserts by id instead of duplicating", () => {
		addSessionRule("s1", rule("r1"));
		addSessionRule("s1", { ...rule("r1"), match: { command: "git status *" } });
		const rules = sessionRules("s1");
		expect(rules).toHaveLength(1);
		expect(rules[0]?.match).toEqual({ command: "git status *" });
	});

	it("keeps per-key stores separate", () => {
		addSessionRule("s1", rule("r1"));
		addSessionRule("s2", rule("r2"));
		expect(sessionRules("s1").map(r => r.id)).toEqual(["r1"]);
		expect(sessionRules("s2").map(r => r.id)).toEqual(["r2"]);
	});

	it("clearSessionRules drops one key or the whole store", () => {
		addSessionRule("s1", rule("r1"));
		addSessionRule("s2", rule("r2"));
		clearSessionRules("s1");
		expect(sessionRules("s1")).toEqual([]);
		expect(sessionRules("s2")).toHaveLength(1);
		clearSessionRules();
		expect(sessionRules("s2")).toEqual([]);
	});

	it("sessionRuleKey prefers the session id over the cwd", () => {
		expect(sessionRuleKey({ cwd: "/a" } as never)).toBe("/a");
		expect(sessionRuleKey({ cwd: "/a", sessionId: "abc" } as never)).toBe("abc");
	});
});
