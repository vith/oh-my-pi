import { describe, expect, it } from "bun:test";
import { deriveForkVersion } from "./fork-bump-version";

describe("deriveForkVersion", () => {
	it("encodes upstream patch+1, commits since the tag, and the short hash", () => {
		expect(
			deriveForkVersion({ tagVersion: "17.2.12", commitsSince: 14, shortHash: "0af9474" }, "17.2.12", "vith-fork"),
		).toBe("17.2.13+vith-fork.14.0af9474");
	});

	it("produces a zero commit count when HEAD is exactly on the tag", () => {
		expect(
			deriveForkVersion({ tagVersion: "17.2.12", commitsSince: 0, shortHash: "f3a2b1c" }, "17.2.12", "vith-fork"),
		).toBe("17.2.13+vith-fork.0.f3a2b1c");
	});

	it("derives from the current core version when no tag is reachable", () => {
		expect(
			deriveForkVersion(
				{ tagVersion: undefined, commitsSince: 3, shortHash: "abc1234" },
				"17.2.13+vith-fork",
				"vith-fork",
			),
		).toBe("17.2.14+vith-fork.3.abc1234");
	});

	it("derives from a plain current version when no tag is reachable", () => {
		expect(
			deriveForkVersion({ tagVersion: undefined, commitsSince: 3, shortHash: "abc1234" }, "17.2.13", "vith-fork"),
		).toBe("17.2.14+vith-fork.3.abc1234");
	});

	it("keeps a custom fork identifier in the first metadata segment", () => {
		expect(
			deriveForkVersion(
				{ tagVersion: "17.2.12", commitsSince: 14, shortHash: "0af9474" },
				"17.2.13+vith-fork",
				"stable",
			),
		).toBe("17.2.13+stable.14.0af9474");
	});
});
