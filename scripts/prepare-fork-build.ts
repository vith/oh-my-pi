#!/usr/bin/env bun
import * as path from "node:path";
import { $, Glob } from "bun";

/** Git identity used by both package builds and the full fork release. */
export interface ForkGitInfo {
	tagVersion: string | undefined;
	commitsSince: number;
	shortHash: string;
}

export function deriveForkVersion(git: ForkGitInfo, currentVersion: string, identifier: string): string {
	const base = git.tagVersion ?? currentVersion.split("+")[0];
	return `${base}+${identifier}.${git.commitsSince}.${git.shortHash}`;
}

/** Read the source identity before any build inputs are rewritten. */
export async function readForkVersion(
	root: string,
	identifier = process.env.OMP_FORK_IDENTIFIER?.trim() || "vith-fork",
): Promise<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) {
		throw new Error(`Invalid fork identifier: ${JSON.stringify(identifier)}`);
	}
	const described = await $`git describe --tags --abbrev=0 --match "v[0-9]*"`.cwd(root).quiet().nothrow();
	const tag = described.exitCode === 0 ? described.text().trim().replace(/^v/, "") : undefined;
	if (tag !== undefined && !/^\d+\.\d+\.\d+$/.test(tag)) {
		throw new Error(`Expected an upstream release tag, got ${JSON.stringify(tag)}`);
	}
	const range = tag ? `v${tag}..HEAD` : "HEAD";
	const commitsSince = Number((await $`git rev-list --count ${range}`.cwd(root).quiet()).text().trim());
	if (!Number.isInteger(commitsSince) || commitsSince < 0) throw new Error("Invalid Git commit count");
	const shortHash = (await $`git rev-parse --short=12 HEAD`.cwd(root).quiet()).text().trim();
	const current = (await Bun.file(path.join(root, "packages/utils/package.json")).json()) as { version: string };
	return deriveForkVersion({ tagVersion: tag, commitsSince, shortHash }, current.version, identifier);
}

/**
 * Stamp JS release identities in a disposable build checkout. Native builders
 * stamp the addon from packages/natives/package.json after linking; Cargo's
 * workspace version and lockfiles need not change for that release identity.
 * No installs, compilation, changelogs, commits, tags, or PATH changes occur here.
 * Install frozen dependencies BEFORE preparing the build.
 */
export async function prepareForkBuild(root: string): Promise<string> {
	const version = await readForkVersion(root);
	for await (const relative of new Glob("packages/*/package.json").scan(root)) {
		const file = Bun.file(path.join(root, relative));
		const text = await file.text();
		const manifest = JSON.parse(text) as { private?: boolean; version?: string };
		if (manifest.private) continue;
		if (typeof manifest.version !== "string") throw new Error(`Missing version in ${relative}`);
		await Bun.write(file, text.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`));
	}
	return version;
}

if (import.meta.main) console.log(await prepareForkBuild(process.cwd()));
