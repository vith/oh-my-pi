import { describe, expect, it } from "bun:test";
import { CURATED_ALLOW_TOOLS, matchCuratedDeny } from "@oh-my-pi/pi-coding-agent/tools/permissions/curated";

describe("curated defaults", () => {
	it("pin the read-only allowlist", () => {
		// Every entry is read-only/metadata-only (read, glob, grep, todo, recall,
		// reflect, web_search, ast_grep, permissions) or inherently interactive
		// (ask — it prompts the user by definition). The exact set is the
		// contract: adding a mutating tool here silently bypasses the posture.
		expect([...CURATED_ALLOW_TOOLS]).toEqual([
			"read",
			"glob",
			"grep",
			"todo",
			"recall",
			"reflect",
			"web_search",
			"ast_grep",
			"ask",
			"permissions",
		]);
		// Mutating/exec tools must never ride the curated allowlist.
		expect(CURATED_ALLOW_TOOLS).not.toContain("bash");
		expect(CURATED_ALLOW_TOOLS).not.toContain("write");
		expect(CURATED_ALLOW_TOOLS).not.toContain("edit");
		expect(CURATED_ALLOW_TOOLS).not.toContain("eval");
	});
	it("denies critical bash patterns", () => {
		expect(matchCuratedDeny("bash", "rm -rf /")?.pattern.test("rm -rf /")).toBe(true);
		expect(matchCuratedDeny("bash", "echo hi")).toBeNull();
		expect(matchCuratedDeny("write", "rm -rf /")).toBeNull(); // non-bash tools unaffected
	});
});
