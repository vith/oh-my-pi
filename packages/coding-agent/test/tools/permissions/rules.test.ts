import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isRuleExpired,
	loadRuleLayers,
	normalizeRule,
	type PermissionRule,
	removeDynamicRule,
	ruleFiles,
	writeDynamicRule,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `perm-rules-${Snowflake.next()}-`));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
afterAll(() => removeSyncWithRetries(tmp));

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("ruleFiles", () => {
	it("resolves the three layer files", () => {
		const files = ruleFiles(project, home);
		expect(files.user).toBe(path.join(home, ".omp", "agent", "permissions.yml"));
		expect(files.dynamic).toBe(path.join(home, ".omp", "agent", "permissions.dynamic.yml"));
		expect(files.project).toBe(path.join(project, ".omp", "permissions.yml"));
	});
});

describe("loadRuleLayers", () => {
	it("merges layers dynamic → project → user in precedence order", () => {
		write(
			path.join(home, ".omp", "agent", "permissions.yml"),
			"rules:\n  - tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			path.join(project, ".omp", "permissions.yml"),
			"rules:\n  - tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		const { rules, errors } = loadRuleLayers(project, home);
		expect(errors).toEqual([]);
		expect(rules.map(r => r.layer)).toEqual(["dynamic", "project", "user"]);
		expect(rules[0].id).toBe("dyn1");
	});
	it("skips invalid rules and reports file errors", () => {
		// Reset layers written by the previous test; assertions count total rules.
		fs.rmSync(path.join(home, ".omp", "agent", "permissions.yml"), { force: true });
		fs.rmSync(path.join(home, ".omp", "agent", "permissions.dynamic.yml"), { force: true });
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
		fs.rmSync(path.join(home, ".omp", "agent", "permissions.yml"), { force: true });
		fs.rmSync(path.join(home, ".omp", "agent", "permissions.dynamic.yml"), { force: true });
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
			layer: "dynamic",
		};
		expect(isRuleExpired({ ...base, ttl: 60, expiresAt: Date.now() - 1 })).toBe(true); // past stamp
		expect(isRuleExpired({ ...base, ttl: 60, expiresAt: Date.now() + 60_000 })).toBe(false); // future stamp
		expect(isRuleExpired({ ...base })).toBe(false); // no ttl — never expires
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

describe("dynamic store", () => {
	it("writes and removes rules atomically by id", async () => {
		const file = path.join(home, ".omp", "agent", "permissions.dynamic.yml");
		await writeDynamicRule(file, {
			id: "d1",
			tool: "bash",
			match: { command: "npm test" },
			action: "allow",
			layer: "dynamic",
		});
		const afterWrite = loadRuleLayers(project, home);
		expect(afterWrite.rules.some(r => r.id === "d1")).toBe(true);
		expect(await removeDynamicRule(file, "d1")).toBe(true);
		expect(loadRuleLayers(project, home).rules.some(r => r.id === "d1")).toBe(false);
	});
});
