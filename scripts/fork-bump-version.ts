#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Fork release — one command to cut a fork build.
 *
 * Mirrors the bump steps of scripts/release.ts (which cannot run in this
 * fork: it requires the `main` branch and pushes tags to origin, i.e. the
 * upstream repo) and adds the native-addon rebuild the compiled binary needs:
 * the coding-agent build embeds `packages/natives/native/*.node` but does NOT
 * compile it, so a checkout whose addon predates the version bump embeds a
 * stale addon and the binary dies at startup with a release-identity mismatch.
 *
 * Version shape: `<nearest vX.Y.Z tag>+<identifier>.<commits since the
 * tag>.<HEAD short hash>`, default identifier `vith-fork` (override via
 * OMP_FORK_IDENTIFIER). The core is the exact upstream tag the fork is based
 * on — never a fabricated bump — so `omp --version` never pretends to be an
 * upstream release that does not exist. The commit count and short hash make
 * the version deterministic per commit: every new commit since the tag bumps
 * the count, so re-running after committing more changes always produces a
 * distinct version, and the hash disambiguates diverged checkouts. Syncing
 * upstream to a newer tag moves the base and resets the count.
 *
 * Pipeline: pre-flight → derive → bump version files → regenerate lockfiles →
 * `bun run check` → commit the bump → build natives → verify release stamp → clear
 * the per-version natives cache → build the binary → smoke-test → link `omp`
 * into PATH. Creates no tag and pushes nothing (a fork tag would become the
 * nearest `v[0-9]*` tag and poison the next derivation).
 */
import { $, Glob } from "bun";
import { containsVersionStamp } from "../packages/natives/native/version-sentinel.js";
import { prepareForkBuild } from "./prepare-fork-build.ts";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`;
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

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	return unreleasedMatch[1].trim().length > 0;
}

async function promoteChangelogs(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];
	for await (const changelog of changelogGlob.scan(".")) {
		let content = await Bun.file(changelog).text();
		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}
		// Drop empty version entries; `[^\]]+` (vs release.ts's `\d+\.\d+\.\d+`)
		// also cleans the fork's suffixed headings.
		content = content.replace(/## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

async function main(): Promise<void> {
	if (!Bun.env.CI || /^(?:0|false)$/i.test(Bun.env.CI)) {
		throw new Error("Fork releases must run in CI; local compilation is disabled.");
	}
	console.log("\n=== Fork Release ===\n");

	// 1. Pre-flight: no tracked changes. Untracked files are ignored — the pi
	// sandbox (ASRT/bwrap) leaves empty read-only mount-point files in the cwd
	// of any sandboxed session (e.g. .bashrc, .gitconfig, .claude/*); they are
	// not the user's work and must not block the bump. `git add -u` below
	// stages only tracked changes, so untracked files can never be swept into
	// the bump commit.
	const status = await git(["status", "--porcelain"]).text();
	const trackedChanges = status.split("\n").filter(line => line.length > 0 && !line.startsWith("??"));
	if (trackedChanges.length > 0) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(trackedChanges.join("\n"));
		process.exit(1);
	}

	// Package builds and full releases share the same derived JS/native identity.
	const version = await prepareForkBuild(process.cwd());
	console.log(`Prepared fork build ${version}`);

	// 4. Root catalog pins (mirrors release.ts's regex exactly).
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@oh-my-pi\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);

	// 5. Rust workspace version (mirrors release.ts).
	console.log("Updating Rust workspace version...");
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// The native build stamps package.json's version into the addon after linking.
	// No per-release Rust export or generated-binding edits are needed.

	// 7. Changelog promotion (mirrors release.ts).
	console.log("Updating CHANGELOGs...");
	await promoteChangelogs(version);

	// 8. Regenerate lockfiles (mirrors release.ts) — the pins rewritten in
	// step 4 are what keep `bun install` resolving locally.
	console.log("Regenerating lockfiles...");
	await $`bun install`;
	await $`cargo update --workspace`;
	// The fork version bump changes Cargo.toml/Cargo.lock, whose content
	// hashes MODULE.bazel.lock embeds — refresh it so the bump commit stays
	// in sync. A stale bazel lock otherwise dirties the tree on the next
	// bazel/bazelisk invocation (observed repeatedly after fork releases).
	await $`bun scripts/gen-nix-bun.ts`;
	await $`bun scripts/gen-clippy-bazelrc.ts`;
	await $`bun scripts/gen-bazel-lock.ts`;

	// 9. Checks (mirrors release.ts).
	console.log("Running checks...");
	await $`bun run check`;

	// 10. Commit the bump before building — a build failure then leaves a
	// clean tree instead of a half-bumped checkout. No tag, no push
	// (deliberate: a fork tag would become the nearest `v[0-9]*` tag and
	// poison the next derivation).
	console.log("Committing...");
	await git(["add", "-u"]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);

	// 11. Build the native addon for this machine. The coding-agent build
	// embeds whatever `packages/natives/native/*.node` is on disk but does not
	// compile it, so this must run first.
	//
	// On Linux, build through the local Cargo/N-API path with the
	// wayland-pipewire feature so the fork binary supports Wayland screencast
	// capture. The Bazel-shipped addons compile with crate_features = [] (the
	// pipewire crate needs system libpipewire via pkg-config). The native CI
	// image/job must provide that dependency for the host build.
	console.log("Building native addon...");
	// Bun Shell's .env() replaces the child environment rather than merging it;
	// preserve PATH, HOME, Cargo configuration, and the rest of the caller's
	// environment before adding the Linux-specific build flags.
	const addonBuildEnv = { ...process.env };
	if (process.platform === "linux") {
		addonBuildEnv.OMP_NATIVE_BUILD_BACKEND = "cargo";
		addonBuildEnv.OMP_NATIVE_PIPEWIRE = "1";
	}
	await $`bun --cwd=packages/natives run build`.env(addonBuildEnv).quiet();
	const platformTag = `${process.platform}-${process.arch}`;
	const nativeDir = "packages/natives/native";

	// 12. Verify the post-link release identity using the loader's own check.
	console.log("Verifying addon release stamp...");
	const builtAddons = addonFilenames(platformTag).filter(name => fs.existsSync(path.join(nativeDir, name)));
	const validAddons: string[] = [];
	for (const name of builtAddons) {
		const fullPath = path.join(nativeDir, name);
		if (containsVersionStamp(await Bun.file(fullPath).bytes(), version)) {
			validAddons.push(name);
			console.log(`  ${name} carries ${version}`);
		} else {
			console.error(`  ${name} does NOT carry ${version} (stale addon)`);
		}
	}
	if (builtAddons.length === 0) {
		console.error(`Error: no addon produced for ${platformTag} in ${nativeDir}. Check the native build output.`);
		process.exit(1);
	}
	if (validAddons.length === 0) {
		console.error(
			`Error: the built addons do not carry release ${version}. Check the native post-link stamping step.`,
		);
		process.exit(1);
	}

	// 13. Clear the per-version cache the loader would otherwise trust: it
	// never auto-cleans the current version's dir and extraction skips on
	// size match, so a stale addon there would be loaded over a fresh build.
	console.log("Clearing natives cache...");
	const cacheDir = nativesCacheDir(version);
	fs.rmSync(cacheDir, { recursive: true, force: true });
	console.log(`  removed ${cacheDir}`);

	// 14. Build the binary (embeds the freshly built addon).
	console.log("Building binary...");
	await $`bun --cwd=packages/coding-agent run build`.quiet();

	// 15. Smoke test.
	console.log("Smoke test...");
	const binary = path.join("packages", "coding-agent", "dist", "omp");
	if (!fs.existsSync(binary)) {
		console.error(`Error: binary not produced at ${binary}`);
		process.exit(1);
	}
	const smoke = await $`${binary} --version`.nothrow().quiet();
	const output = smoke.stdout.toString().trim();
	if (smoke.exitCode !== 0 || !output.includes(`omp/${version}`)) {
		console.error(
			`Error: smoke test failed — "${binary} --version" exited ${smoke.exitCode} with:\n${output}\n` +
				"If it is a native release-identity error, check the addon stamp.",
		);
		process.exit(1);
	}
	console.log(`  ✓ ${output}`);

	// 16. Link `omp` into PATH so the fresh checkout is runnable from the
	// shell. Best-effort: a failed link leaves the built binary usable.
	console.log("Linking omp into PATH...");
	const link = await $`bun --cwd=packages/coding-agent link && sh scripts/link-omp.sh`.nothrow().quiet();
	if (link.exitCode !== 0) {
		const detail = (link.stderr.toString().trim() || link.stdout.toString().trim()).split("\n").pop() ?? "";
		console.warn(`  warning: link step failed (${detail}); run it manually later`);
	} else {
		console.log("  ✓ linked");
	}

	console.log(`\nDone. Binary: ${binary}, shell command: omp --version`);
}

if (import.meta.main) await main();
