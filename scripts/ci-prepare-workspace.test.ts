import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const directories: string[] = [];
const script = path.join(import.meta.dir, "ci-prepare-workspace.sh");

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ source: string; workspace: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ci-source-cache-"));
	directories.push(root);
	const source = path.join(root, "source");
	const workspace = path.join(root, "workspace");
	await fs.mkdir(source);
	return { source, workspace };
}

async function prepare(source: string, workspace: string): Promise<string> {
	return (await $`bash ${script} ${source} ${workspace}`.quiet().text()).trim();
}

describe.skipIf(process.platform !== "linux")("CI cached source workspace", () => {
	it("preserves unchanged source mtimes but invalidates same-size edits and removes deleted sources", async () => {
		const { source, workspace } = await fixture();
		await Bun.write(path.join(source, "crate.rs"), "old\n");
		await Bun.write(path.join(source, "obsolete.rs"), "removed later\n");
		const cached = await prepare(source, workspace);
		const target = path.join(cached, "crate.rs");
		const stamp = new Date("2000-01-01T00:00:00Z");
		await fs.utimes(target, stamp, stamp);
		await fs.utimes(path.join(source, "crate.rs"), new Date(), new Date());

		await prepare(source, workspace);
		expect((await fs.stat(target)).mtimeMs).toBe(stamp.getTime());

		// Identical size and mtime must not hide changed source content.
		await Bun.write(path.join(source, "crate.rs"), "new\n");
		await fs.utimes(path.join(source, "crate.rs"), stamp, stamp);
		await fs.unlink(path.join(source, "obsolete.rs"));
		await prepare(source, workspace);
		expect(await Bun.file(target).text()).toBe("new\n");
		expect((await fs.stat(target)).mtimeMs).not.toBe(stamp.getTime());
		expect(await Bun.file(path.join(cached, "obsolete.rs")).exists()).toBe(false);
	});

	it("retains dependency and build caches while synchronizing permissions and symlinks", async () => {
		const { source, workspace } = await fixture();
		await Bun.write(path.join(source, "entry.sh"), "echo source\n");
		await fs.chmod(path.join(source, "entry.sh"), 0o755);
		await fs.symlink("entry.sh", path.join(source, "entry"));
		await prepare(source, workspace);
		const caches = [
			"node_modules/cache-entry",
			"packages/tui/node_modules/cache-entry",
			"packages/coding-agent/dist/omp",
			"packages/natives/native/pi_natives.linux-arm64.node",
		];
		for (const cache of caches) await Bun.write(path.join(workspace, cache), "cached artifact");
		await Bun.write(path.join(workspace, "stale-source.ts"), "stale");
		await fs.chmod(path.join(source, "entry.sh"), 0o644);
		await fs.unlink(path.join(source, "entry"));
		await fs.symlink("replacement.sh", path.join(source, "entry"));

		await prepare(source, workspace);
		for (const cache of caches) expect(await Bun.file(path.join(workspace, cache)).text()).toBe("cached artifact");
		expect((await fs.stat(path.join(workspace, "entry.sh"))).mode & 0o777).toBe(0o644);
		expect(await fs.readlink(path.join(workspace, "entry"))).toBe("replacement.sh");
		expect(await Bun.file(path.join(workspace, "stale-source.ts")).exists()).toBe(false);
	});

	it("refuses overlapping source and cache directories before modifying them", async () => {
		const { source } = await fixture();
		const file = path.join(source, "keep.rs");
		await Bun.write(file, "keep\n");
		const nested = path.join(source, "cache");
		const result = await $`bash ${script} ${source} ${nested}`.quiet().nothrow();
		expect(result.exitCode).toBe(1);
		expect(await Bun.file(file).text()).toBe("keep\n");
	});
});
