import { describe, expect, it } from "bun:test";
import { deriveForkVersion } from "./fork-bump-version";

describe("deriveForkVersion", () => {
	it("derives the first fork build as patch+1 of the nearest upstream tag", () => {
		expect(deriveForkVersion("17.2.12", "17.2.12", "vith-fork")).toBe("17.2.13+vith-fork");
	});

	it("iterates build metadata when the current version is already a fork build of the same base", () => {
		expect(deriveForkVersion("17.2.12", "17.2.13+vith-fork", "vith-fork")).toBe("17.2.13+vith-fork.2");
	});

	it("iterates again for subsequent fork builds on the same base", () => {
		expect(deriveForkVersion("17.2.12", "17.2.13+vith-fork.2", "vith-fork")).toBe("17.2.13+vith-fork.3");
	});

	it("resets the iteration when upstream has been synced to a newer tag", () => {
		expect(deriveForkVersion("17.2.13", "17.2.13+vith-fork.2", "vith-fork")).toBe("17.2.14+vith-fork");
	});

	it("starts a fresh sequence for a different fork identifier", () => {
		expect(deriveForkVersion("17.2.12", "17.2.13+vith-fork.2", "stable")).toBe("17.2.13+stable");
	});

	it("falls back to the current core version when no tag is reachable", () => {
		expect(deriveForkVersion(undefined, "17.2.12", "vith-fork")).toBe("17.2.13+vith-fork");
	});

	it("derives from a fork-versioned current when no tag is reachable", () => {
		expect(deriveForkVersion(undefined, "17.2.13+vith-fork", "vith-fork")).toBe("17.2.14+vith-fork");
	});
});
