import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearRuleLayerCache,
	foldLegacyDynamicRules,
	isRuleExpired,
	loadRuleLayers,
	normalizeRule,
	type PermissionRule,
	removeUserRule,
	ruleFiles,
	writeRulesFile,
	writeUserRule,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `perm-rules-${Snowflake.next()}-`));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
const userRulesFile = path.join(home, ".omp", "agent", "permissions.yml");
const legacyDynamicFile = path.join(home, ".omp", "agent", "permissions.dynamic.yml");
afterAll(() => removeSyncWithRetries(tmp));
afterEach(() => clearRuleLayerCache());

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("ruleFiles", () => {
	it("resolves the two layer files plus the legacy dynamic path", () => {
		const files = ruleFiles(project, home);
		expect(files.user).toBe(userRulesFile);
		expect(files.project).toBe(path.join(project, ".omp", "permissions.yml"));
		expect(files.legacyDynamic).toBe(legacyDynamicFile);
	});
});

describe("loadRuleLayers", () => {
	it("merges layers project → user in precedence order", () => {
		write(userRulesFile, "rules:\n  - tool: bash\n    match: { command: 'git *' }\n    action: allow\n");
		write(
			path.join(project, ".omp", "permissions.yml"),
			"rules:\n  - tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		const { rules, errors } = loadRuleLayers(project, home);
		expect(errors).toEqual([]);
		expect(rules.map(r => r.layer)).toEqual(["project", "user"]);
		expect(rules[0].tool).toBe("write");
	});
	it("skips invalid rules and reports file errors", () => {
		// Reset layers written by the previous test; assertions count total rules.
		fs.rmSync(userRulesFile, { force: true });
		write(
			path.join(project, ".omp", "permissions.yml"),
			"rules:\n  - tool: bash\n    action: allow\n  - tool: '*'   \n    match: { command: 'x' }\n    action: allow\n",
		);
		const { rules, errors } = loadRuleLayers(project, home);
		expect(rules).toHaveLength(1);
		expect(rules[0].tool).toBe("*");
		expect(errors).toHaveLength(1); // the match-less rule is reported
	});
	it("drops expired ttl rules at load", () => {
		// Reset layers written by the previous tests; assertions count total rules.
		fs.rmSync(userRulesFile, { force: true });
		// A fresh ttl rule survives load: the stamp is load time + ttl.
		write(
			path.join(project, ".omp", "permissions.yml"),
			"rules:\n  - id: exp\n    tool: bash\n    match: { command: 'x' }\n    action: allow\n    ttl: 1\n",
		);
		expect(loadRuleLayers(project, home).rules).toHaveLength(1);
		// ttl 0 stamps the rule expired at load time, so the drop branch runs.
		write(
			path.join(project, ".omp", "permissions.yml"),
			"rules:\n  - id: exp\n    tool: bash\n    match: { command: 'x' }\n    action: allow\n    ttl: 0\n",
		);
		expect(loadRuleLayers(project, home).rules).toHaveLength(0);
	});
	it("isRuleExpired compares the load-time stamp against now", () => {
		const base: PermissionRule = {
			id: "r1",
			tool: "bash",
			match: { command: "x" },
			action: "allow",
			layer: "user",
		};
		expect(isRuleExpired({ ...base, ttl: 60, expiresAt: Date.now() - 1 })).toBe(true); // past stamp
		expect(isRuleExpired({ ...base, ttl: 60, expiresAt: Date.now() + 60_000 })).toBe(false); // future stamp
		expect(isRuleExpired({ ...base })).toBe(false); // no ttl — never expires
	});

	it("caches layer loads until a layer file's mtime or size changes", () => {
		clearRuleLayerCache();
		const readSpy = vi.spyOn(fs, "readFileSync");
		try {
			write(
				path.join(project, ".omp", "permissions.yml"),
				"rules:\n  - id: cached1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
			);
			loadRuleLayers(project, home);
			loadRuleLayers(project, home);
			// Two loads of unchanged files: one parse pass (two reads — the
			// missing user file still attempts a read, the missing legacy file is
			// stat-checked and skipped).
			expect(readSpy).toHaveBeenCalledTimes(2);
			// A rewrite with different content (size change) invalidates the cache.
			write(
				path.join(project, ".omp", "permissions.yml"),
				"rules:\n  - id: cached2\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
			);
			loadRuleLayers(project, home);
			expect(readSpy).toHaveBeenCalledTimes(4);
			// A pure mtime touch (same content and size) also invalidates it.
			write(
				path.join(project, ".omp", "permissions.yml"),
				"rules:\n  - id: cached2\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
			);
			fs.utimesSync(
				path.join(project, ".omp", "permissions.yml"),
				new Date(Date.now() - 60_000),
				new Date(Date.now() + 60_000),
			);
			loadRuleLayers(project, home);
			expect(readSpy).toHaveBeenCalledTimes(6);
			// Re-loads reflect the latest file content.
			expect(loadRuleLayers(project, home).rules.some(r => r.id === "cached2")).toBe(true);
		} finally {
			readSpy.mockRestore();
			clearRuleLayerCache();
		}
	});
});

describe("normalizeRule", () => {
	it("validates shape and auto-generates ids", () => {
		const rule = normalizeRule({ tool: "bash", match: { command: "git *" }, action: "allow" }, "user");
		expect(rule?.action).toBe("allow");
		expect(rule?.id.length).toBeGreaterThan(0);
		expect(normalizeRule({ tool: "bash", action: "allow" }, "user")).toBeNull(); // no match
		expect(normalizeRule({ tool: "bash", match: { command: "x" }, action: "nope" }, "user")).toBeNull();
	});
});

describe("user store", () => {
	it("writes and removes rules atomically by id", async () => {
		const file = userRulesFile;
		await writeUserRule(file, {
			id: "d1",
			tool: "bash",
			match: { command: "npm test" },
			action: "allow",
			layer: "user",
		});
		const afterWrite = loadRuleLayers(project, home);
		expect(afterWrite.rules.some(r => r.id === "d1")).toBe(true);
		expect(await removeUserRule(file, "d1")).toBe(true);
		expect(loadRuleLayers(project, home).rules.some(r => r.id === "d1")).toBe(false);
	});

	it("writeRulesFile replaces the whole rules list under the lock", async () => {
		const file = userRulesFile;
		await writeRulesFile(file, [{ id: "a", tool: "bash", match: { command: "x" }, action: "allow" }]);
		await writeRulesFile(file, [{ id: "b", tool: "bash", match: { command: "y" }, action: "deny" }]);
		const userRules = loadRuleLayers(project, home).rules.filter(rule => rule.layer === "user");
		expect(userRules.map(rule => rule.id)).toEqual(["b"]);
	});

	it("remove of an unknown id returns false without touching the file", async () => {
		const file = userRulesFile;
		// A missing file stays missing: no-op removes never create it.
		fs.rmSync(file, { force: true });
		expect(await removeUserRule(file, "nope")).toBe(false);
		expect(fs.existsSync(file)).toBe(false);
		// An existing file keeps its exact bytes: no-op removes never rewrite it.
		write(file, "rules:\n  - id: d1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n");
		const before = fs.readFileSync(file, "utf8");
		expect(await removeUserRule(file, "nope")).toBe(false);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});

describe("legacy dynamic file", () => {
	it("loadRuleLayers folds legacy dynamic rules into the user layer after hand-written rules", () => {
		write(
			userRulesFile,
			"rules:\n  - id: hand1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			legacyDynamicFile,
			"rules:\n  - id: old1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		const { rules } = loadRuleLayers(project, home);
		const userRules = rules.filter(rule => rule.layer === "user");
		expect(userRules.map(rule => rule.id)).toEqual(["hand1", "old1"]);
	});

	it("foldLegacyDynamicRules merges the legacy file into the user file and removes it", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: hand1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			legacyDynamicFile,
			"rules:\n  - id: old1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		const folded = await foldLegacyDynamicRules(project, home);
		expect(folded).toBe(1);
		expect(fs.existsSync(legacyDynamicFile)).toBe(false);
		const doc = YAML.parse(await Bun.file(userRulesFile).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.map(rule => rule.id)).toEqual(["hand1", "old1"]);
		expect(loadRuleLayers(project, home).rules.filter(rule => rule.layer === "user")).toHaveLength(2);
		// Idempotent: nothing left to fold.
		expect(await foldLegacyDynamicRules(project, home)).toBe(0);
	});

	it("foldLegacyDynamicRules returns 0 when no legacy file exists", async () => {
		fs.rmSync(legacyDynamicFile, { force: true });
		expect(await foldLegacyDynamicRules(project, home)).toBe(0);
	});
});
