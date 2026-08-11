import { describe, expect, it } from "bun:test";
import { CURATED_ALLOW_TOOLS, matchCuratedDeny } from "@oh-my-pi/pi-coding-agent/tools/permissions/curated";

describe("curated defaults", () => {
	it("pin the read-only allowlist", () => {
		expect(CURATED_ALLOW_TOOLS).toContain("read");
		expect(CURATED_ALLOW_TOOLS).toContain("glob");
		expect(CURATED_ALLOW_TOOLS).toContain("permissions");
		expect(CURATED_ALLOW_TOOLS).not.toContain("bash");
		expect(CURATED_ALLOW_TOOLS).not.toContain("write");
	});
	it("denies critical bash patterns", () => {
		expect(matchCuratedDeny("bash", "rm -rf /")?.pattern.test("rm -rf /")).toBe(true);
		expect(matchCuratedDeny("bash", "echo hi")).toBeNull();
		expect(matchCuratedDeny("write", "rm -rf /")).toBeNull(); // non-bash tools unaffected
	});
});
