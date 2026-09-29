import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nativesCacheDir } from "./fork-bump-version";
import { deriveForkVersion } from "./prepare-fork-build";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-bump-"));
	tempDirs.push(dir);
	return dir;
}

describe("deriveForkVersion", () => {
	it("uses the nearest upstream tag verbatim, never a fabricated patch bump", () => {
		expect(
			deriveForkVersion({ tagVersion: "17.2.12", commitsSince: 14, shortHash: "0af9474" }, "17.2.12", "vith-fork"),
		).toBe("17.2.12+vith-fork.14.0af9474");
	});

	it("produces a zero commit count when HEAD is exactly on the tag", () => {
		expect(
			deriveForkVersion({ tagVersion: "17.2.12", commitsSince: 0, shortHash: "f3a2b1c" }, "17.2.12", "vith-fork"),
		).toBe("17.2.12+vith-fork.0.f3a2b1c");
	});

	it("derives from the current core version when no tag is reachable", () => {
		expect(
			deriveForkVersion(
				{ tagVersion: undefined, commitsSince: 3, shortHash: "abc1234" },
				"17.2.13+vith-fork",
				"vith-fork",
			),
		).toBe("17.2.13+vith-fork.3.abc1234");
	});

	it("keeps a custom fork identifier in the first metadata segment", () => {
		expect(
			deriveForkVersion(
				{ tagVersion: "17.2.12", commitsSince: 14, shortHash: "0af9474" },
				"17.2.13+vith-fork",
				"stable",
			),
		).toBe("17.2.12+stable.14.0af9474");
	});
});

describe("nativesCacheDir", () => {
	it("uses XDG_DATA_HOME when its omp directory exists", async () => {
		const xdg = await makeTempDir();
		await fs.mkdir(path.join(xdg, "omp"));
		expect(nativesCacheDir("17.2.13+vith-fork.55.ea3ca9cd6", { XDG_DATA_HOME: xdg })).toBe(
			path.join(xdg, "omp", "natives", "17.2.13+vith-fork.55.ea3ca9cd6"),
		);
	});

	it("falls back to ~/.omp/natives when XDG is unset or has no omp directory", async () => {
		const emptyXdg = await makeTempDir();
		expect(nativesCacheDir("17.2.13+vith-fork.55.ea3ca9cd6", { XDG_DATA_HOME: emptyXdg })).toBe(
			path.join(os.homedir(), ".omp", "natives", "17.2.13+vith-fork.55.ea3ca9cd6"),
		);
		expect(nativesCacheDir("17.2.13+vith-fork.55.ea3ca9cd6", {})).toBe(
			path.join(os.homedir(), ".omp", "natives", "17.2.13+vith-fork.55.ea3ca9cd6"),
		);
	});
});
