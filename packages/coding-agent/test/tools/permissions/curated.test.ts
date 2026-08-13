import { describe, expect, it, test } from "bun:test";
import {
	CURATED_ALLOW_TOOLS,
	isSafeConsumerStage,
	matchCuratedDeny,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/curated";

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

describe("safe-consumer stages (spec §3.4/§4.3)", () => {
	test("curated filters are exempt; exec-capable commands are not", () => {
		expect(isSafeConsumerStage("head -1")).toBe(true);
		expect(isSafeConsumerStage("/usr/bin/tail -n 20")).toBe(true);
		expect(isSafeConsumerStage("grep -E 'x'")).toBe(true);
		expect(isSafeConsumerStage("sh -c 'x'")).toBe(false);
		expect(isSafeConsumerStage("xargs rm")).toBe(false);
		expect(isSafeConsumerStage("sed -i s/a/b/")).toBe(false);
		expect(isSafeConsumerStage("awk '{print}'")).toBe(false);
		expect(isSafeConsumerStage("python3 -c 'x'")).toBe(false);
	});
});
