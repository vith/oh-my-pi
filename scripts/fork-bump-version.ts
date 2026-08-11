#!/usr/bin/env bun
/**
 * Fork version bump — mirrors the bump steps of scripts/release.ts (which
 * cannot run in this fork: it requires the `main` branch and pushes tags to
 * origin, i.e. the upstream repo).
 *
 * Version shape: `<nearest vX.Y.Z tag, patch+1>+<identifier>`, default
 * identifier `vith-fork` (override via OMP_FORK_IDENTIFIER). Re-running on
 * the same upstream tag iterates the build metadata (`17.2.13+vith-fork` →
 * `17.2.13+vith-fork.2`) so another fork build can be produced without
 * syncing upstream; a newer tag or a different identifier starts a fresh
 * sequence. Commits the bump but creates no tag and pushes nothing.
 */
import { $, Glob } from "bun";
import { compareVersions } from "../packages/utils/src/version.ts";

const FORK_IDENTIFIER = process.env.OMP_FORK_IDENTIFIER?.trim() || "vith-fork";
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
if (!IDENTIFIER_RE.test(FORK_IDENTIFIER)) {
	console.error(`Error: fork identifier must match ${IDENTIFIER_RE} (got ${JSON.stringify(FORK_IDENTIFIER)})`);
	process.exit(1);
}

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`;
}

function bumpPatch(version: string): string {
	const match = version.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) throw new Error(`Cannot bump non-numeric version: ${version}`);
	return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

/**
 * Derive the next fork version.
 *
 * The base is the nearest upstream tag's patch+1 (or the current core version
 * when no tag is reachable) plus the fork identifier. When `currentVersion`
 * is already a fork build of that base, the build metadata is iterated
 * (`17.2.13+vith-fork` → `17.2.13+vith-fork.2`) so the script can be re-run
 * for another fork build on the same upstream version. A newer `base` (after
 * syncing upstream) or a different identifier starts a fresh sequence.
 */
export function deriveForkVersion(base: string | undefined, currentVersion: string, identifier: string): string {
	const patchBase = base ?? currentVersion.split("+")[0];
	const baseFork = `${bumpPatch(patchBase)}+${identifier}`;
	const iterationPrefix = `${baseFork}.`;
	if (currentVersion === baseFork || currentVersion.startsWith(iterationPrefix)) {
		const suffix = currentVersion.slice(iterationPrefix.length);
		const iteration = /^\d+$/.test(suffix) ? Number(suffix) : 1;
		return `${baseFork}.${iteration + 1}`;
	}
	return baseFork;
}

/** Nearest reachable tag matching upstream release style `vX.Y.Z` (e.g. `v17.2.12`). */
async function nearestTagVersion(): Promise<string | undefined> {
	const result = await $`git describe --tags --abbrev=0 --match "v[0-9]*"`.quiet().nothrow();
	if (result.exitCode !== 0) return undefined;
	const tag = result.stdout.toString().trim().replace(/^v/, "");
	return /^\d+\.\d+\.\d+$/.test(tag) ? tag : undefined;
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
	console.log("\n=== Fork Version Bump ===\n");

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

	// 2. Derive the fork version: nearest upstream tag (or the current core
	// version when no tag is reachable), patch+1, `+` suffix. If the current
	// version is already a fork build of the same base, the build metadata is
	// iterated so a second fork build on the same upstream version is possible.
	const tag = await nearestTagVersion();
	const current = (await Bun.file("packages/utils/package.json").json()) as { version: string };
	const version = deriveForkVersion(tag, current.version, FORK_IDENTIFIER);
	console.log(
		`  base: ${tag ?? current.version.split("+")[0]} (${tag ? "git tag" : "package.json fallback"}), target: ${version}`,
	);

	if (tag && compareVersions(version, tag) <= 0) {
		console.error(`Error: Version ${version} must be greater than latest tag v${tag}`);
		process.exit(1);
	}

	// 3. Rewrite every public package.json version (mirrors release.ts:
	// private packages are skipped).
	console.log("Updating package versions...");
	const pkgJsonPaths: string[] = [];
	for await (const pkgPath of packageJsonGlob.scan(".")) {
		const pkgJson = (await Bun.file(pkgPath).json()) as { private?: boolean; name: string };
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		pkgJsonPaths.push(pkgPath);
	}
	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${pkgJsonPaths}`;

	// 4. Root catalog pins (mirrors release.ts's regex exactly).
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@oh-my-pi\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);

	// 5. Rust workspace version (mirrors release.ts).
	console.log("Updating Rust workspace version...");
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// 6. pi-natives version sentinel in lock-step (mirrors release.ts's sd +
	// verification; `replace(/[^A-Za-z0-9]/g, "_")` is the same rule the JS
	// loader uses, so the suffix stays consistent across all three files).
	console.log(`Bumping pi-natives version sentinel to v${version}...`);
	const sentinelName = `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
	const sentinelFiles = [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/index.js",
	];
	await $`sd '__piNativesV[A-Za-z0-9_]+' ${sentinelName} ${sentinelFiles}`;
	const libRs = await Bun.file("crates/pi-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		console.error(
			`Error: pi-natives version sentinel did not move to ${sentinelName} in crates/pi-natives/src/lib.rs. ` +
				"The `__piNativesV…` literal may have been removed or renamed; restore it before bumping.",
		);
		process.exit(1);
	}
	console.log(`  sentinel: ${sentinelName}`);

	// 7. Changelog promotion (mirrors release.ts).
	console.log("Updating CHANGELOGs...");
	await promoteChangelogs(version);

	// 8. Regenerate lockfiles (mirrors release.ts) — the pins rewritten in
	// step 4 are what keep `bun install` resolving locally.
	console.log("Regenerating lockfiles...");
	await $`rm -f bun.lock`;
	await $`bun install`;
	await $`cargo generate-lockfile`;

	// 9. Checks (mirrors release.ts).
	console.log("Running checks...");
	await $`bun run check`;

	// 10. Commit only — no tag, no push (deliberate: a fork tag would become
	// the nearest `v[0-9]*` tag and poison the next derivation).
	console.log("Committing...");
	await git(["add", "-u"]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);
	console.log("\nDone. Run `bun --cwd=packages/coding-agent run build` to produce a binary.");
}

if (import.meta.main) await main();
