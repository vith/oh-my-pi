import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { prepareForkBuild } from "./prepare-fork-build";

// A package build must not ship upstream-only identity or leave its addon on
// a different release, and preparation must not act as a full release.
test("prepares matching fork identities without releasing or changing dependency inputs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-prepare-"));
	try {
		for (const name of ["utils", "natives", "coding-agent", "private-app"]) {
			await Bun.write(
				path.join(root, "packages", name, "package.json"),
				JSON.stringify({
					name,
					version: "18.4.2",
					private: name === "private-app",
				}),
			);
		}
		const preserved = ["package.json", "bun.lock", "Cargo.toml", "Cargo.lock", "packages/coding-agent/CHANGELOG.md"];
		for (const relative of preserved) await Bun.write(path.join(root, relative), "unchanged\n");
		await $`git init -q ${root}`.quiet();
		await $`git -C ${root} add .`.quiet();
		await $`git -C ${root} -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=/dev/null commit -qm base`.quiet();
		await $`git -C ${root} tag v18.4.2`.quiet();
		await $`git -C ${root} -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=/dev/null commit --allow-empty -qm fork`.quiet();
		const head = (await $`git -C ${root} rev-parse HEAD`.quiet()).text().trim();
		const version = await prepareForkBuild(root);
		expect(version).toBe(`18.4.2+${process.env.OMP_FORK_IDENTIFIER?.trim() || "vith-fork"}.1.${head.slice(0, 12)}`);
		for (const name of ["utils", "natives", "coding-agent"]) {
			expect((await Bun.file(path.join(root, "packages", name, "package.json")).json()).version).toBe(version);
		}
		expect((await Bun.file(path.join(root, "packages/private-app/package.json")).json()).version).toBe("18.4.2");
		for (const relative of preserved) expect(await Bun.file(path.join(root, relative)).text()).toBe("unchanged\n");
		expect((await $`git -C ${root} rev-parse HEAD`.quiet()).text().trim()).toBe(head);
		expect((await $`git -C ${root} tag`.quiet()).text().trim()).toBe("v18.4.2");
		expect(await prepareForkBuild(root)).toBe(version);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
