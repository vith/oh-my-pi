#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Complete fork rebuild — produce a working `omp` binary from a checkout.
 *
 * The coding-agent build embeds whatever `packages/natives/native/*.node`
 * addon is on disk but does NOT compile it (`gen:native` only regenerates the
 * JS bindings). After `release:fork` bumps the version sentinel, a checkout
 * whose native addon was never rebuilt embeds a stale addon and the binary
 * fails at startup with "Failed to load pi_natives native addon ... version
 * sentinel". This script fixes that ordering:
 *
 *   1. build the native addon (bazel-natives host) for this machine
 *   2. verify the rebuilt addon exposes the sentinel matching the version
 *   3. clear the per-version natives cache (the loader never auto-cleans the
 *      current version's cache dir, and extraction skips on size match)
 *   4. build the binary
 *   5. smoke-test `dist/omp --version` against the expected version
 *
 * Usage:
 *   bun scripts/fork-rebuild.ts [repo-root]
 *
 * `repo-root` defaults to this checkout; pass another path to rebuild a
 * different checkout (e.g. the merged integration clone) from here.
 */
import { $ } from "bun";

const repoRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dir, ".."));

/** The napi export name the loader validates, e.g. `__piNativesV17_2_13_vith_fork_2`. */
export function expectedSentinel(version: string): string {
	return `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * Addon filenames for a platform tag, mirroring the loader's
 * `getAddonFilenames` (modern/baseline are x64-only variants).
 */
export function addonFilenames(platformTag: string): string[] {
	return [
		`pi_natives.${platformTag}.node`,
		`pi_natives.${platformTag}-modern.node`,
		`pi_natives.${platformTag}-baseline.node`,
	];
}

/**
 * The per-version native cache directory, mirroring the loader's
 * `getNativesDir()`: XDG_DATA_HOME wins only when its `omp` directory exists.
 */
export function nativesCacheDir(version: string, env: Record<string, string | undefined> = process.env): string {
	const xdg = env.XDG_DATA_HOME;
	if (xdg && fs.existsSync(path.join(xdg, "omp"))) {
		return path.join(xdg, "omp", "natives", version);
	}
	return path.join(os.homedir(), ".omp", "natives", version);
}

async function fileContainsSentinel(filePath: string, sentinel: string): Promise<boolean> {
	try {
		const content = await Bun.file(filePath).text();
		return content.includes(sentinel);
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	console.log(`\n=== Fork Rebuild (${repoRoot}) ===\n`);

	const nativesPkgPath = path.join(repoRoot, "packages", "natives", "package.json");
	const nativesPkg = (await Bun.file(nativesPkgPath).json()) as { version?: string };
	if (!nativesPkg.version) {
		throw new Error(`Cannot read version from ${nativesPkgPath}`);
	}
	const version = nativesPkg.version;
	const sentinel = expectedSentinel(version);
	console.log(`  version: ${version}, expected addon sentinel: ${sentinel}`);

	// 1. Build the native addon for this machine.
	console.log("\n[1/4] Building native addon...");
	await $`bun --cwd=packages/natives run build`.cwd(repoRoot).quiet();
	const platformTag = `${process.platform}-${process.arch}`;
	const nativeDir = path.join(repoRoot, "packages", "natives", "native");
	const builtAddons = addonFilenames(platformTag).filter(name => fs.existsSync(path.join(nativeDir, name)));

	// 2. Verify the rebuilt addon carries the current sentinel.
	console.log("[2/4] Verifying addon sentinel...");
	const validAddons: string[] = [];
	for (const name of builtAddons) {
		const fullPath = path.join(nativeDir, name);
		if (await fileContainsSentinel(fullPath, sentinel)) {
			validAddons.push(name);
			console.log(`  ✓ ${name} exposes ${sentinel}`);
		} else {
			console.error(`  ✗ ${name} does NOT expose ${sentinel} (stale addon)`);
		}
	}
	if (builtAddons.length === 0) {
		throw new Error(
			`No addon produced for ${platformTag} at ${nativeDir}. Check the native build output and try again.`,
		);
	}
	if (validAddons.length === 0) {
		throw new Error(
			`The built addons do not expose ${sentinel}. The Rust crate is out of sync with the version ` +
				"bump — ensure `release:fork` updated crates/pi-natives/src/lib.rs and rebuild.",
		);
	}

	// 3. Clear the per-version cache the loader would otherwise trust.
	console.log("[3/4] Clearing natives cache...");
	const cacheDir = nativesCacheDir(version);
	fs.rmSync(cacheDir, { recursive: true, force: true });
	console.log(`  removed ${cacheDir}`);

	// 4. Build the binary (embeds the freshly built addon).
	console.log("[4/4] Building binary...");
	await $`bun --cwd=packages/coding-agent run build`.cwd(repoRoot).quiet();

	// 5. Smoke test.
	console.log("\nSmoke test...");
	const binary = path.join(repoRoot, "packages", "coding-agent", "dist", "omp");
	if (!fs.existsSync(binary)) {
		throw new Error(`Binary not produced at ${binary}`);
	}
	const result = await $`${binary} --version`.nothrow().quiet();
	const output = result.stdout.toString().trim();
	if (result.exitCode !== 0 || !output.includes(`omp/${version}`)) {
		throw new Error(
			`Smoke test failed: "${binary} --version" exited ${result.exitCode} with output:\n${output}\n` +
				"If it is a natives sentinel error, the addon cache may still be stale; " +
				`delete ${cacheDir} and re-run.`,
		);
	}
	console.log(`  ✓ ${output}`);

	console.log(
		`\nDone. Binary: ${binary}\n` +
			"Run it directly, or install the dev wrapper into PATH:\n" +
			"  bun --cwd=packages/coding-agent link && sh scripts/link-omp.sh",
	);
}

if (import.meta.main) await main();
