import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addonFilenames, expectedSentinel, nativesCacheDir } from "./fork-rebuild";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-rebuild-"));
	tempDirs.push(dir);
	return dir;
}

describe("expectedSentinel", () => {
	it("derives the sentinel export name from a fork version with build metadata", () => {
		expect(expectedSentinel("17.2.13+vith-fork.2")).toBe("__piNativesV17_2_13_vith_fork_2");
	});

	it("derives the sentinel export name from a plain release version", () => {
		expect(expectedSentinel("17.2.12")).toBe("__piNativesV17_2_12");
	});
});

describe("nativesCacheDir", () => {
	it("uses XDG_DATA_HOME when its omp directory exists", async () => {
		const xdg = await makeTempDir();
		await fs.mkdir(path.join(xdg, "omp"));
		expect(nativesCacheDir("17.2.13+vith-fork.2", { XDG_DATA_HOME: xdg })).toBe(
			path.join(xdg, "omp", "natives", "17.2.13+vith-fork.2"),
		);
	});

	it("falls back to ~/.omp/natives when XDG is unset or has no omp directory", async () => {
		const emptyXdg = await makeTempDir();
		expect(nativesCacheDir("17.2.13+vith-fork.2", { XDG_DATA_HOME: emptyXdg })).toBe(
			path.join(os.homedir(), ".omp", "natives", "17.2.13+vith-fork.2"),
		);
		expect(nativesCacheDir("17.2.13+vith-fork.2", {})).toBe(
			path.join(os.homedir(), ".omp", "natives", "17.2.13+vith-fork.2"),
		);
	});
});

describe("addonFilenames", () => {
	it("lists the modern, baseline, and default addon filenames for an x64 tag", () => {
		expect(addonFilenames("linux-x64")).toEqual([
			"pi_natives.linux-x64.node",
			"pi_natives.linux-x64-modern.node",
			"pi_natives.linux-x64-baseline.node",
		]);
	});
});
