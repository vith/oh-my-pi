import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgPermissionsDefault } from "@oh-my-pi/pi-coding-agent/tools/permissions/settings";
import { appendAudit, auditFilePath } from "@oh-my-pi/pi-coding-agent/tools/permissions/audit";
import {
	cyclePosture,
	permissionsSchema,
	runModeCommand,
	runPermissionCommand,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/manage";
import { loadRuleLayers } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `perm-manage-${Snowflake.next()}-`));
const agentDir = path.join(tmp, "agent");
const home = path.join(tmp, "home");
const cwd = path.join(tmp, "project");
const userRulesFile = path.join(home, ".omp", "agent", "permissions.yml");

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
	// The discovery fs cache negative-caches missing files by path; the reused
	// tmp dirs are wiped below, so stale "not found" entries must go too.
	clearFsCache();
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	// runPermissionCommand resolves the user/project layers against
	// the OS home; point it at the temp home so no test touches the real one.
	vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
	clearFsCache();
	restoreSettingsTestState(settingsState);
});

afterAll(() => {
	removeSyncWithRetries(tmp);
});

/** Settings initialized against the temp agent dir, plus the command context. */
async function ctx() {
	const settings = await Settings.init({ agentDir, cwd });
	return { cwd, settings, sessionId: undefined };
}

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("runPermissionCommand list", () => {
	it("lists merged rules by layer in precedence order with audit match counts", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		await appendAudit(auditFilePath(cwd), {
			ts: Date.now(),
			tool: "bash",
			command: "git status",
			decision: "allow",
			ruleId: "user1",
			layer: "user",
		});

		const output = await runPermissionCommand("list", await ctx());

		// Layers appear highest-precedence first (project before user).
		expect(output.indexOf("project:")).toBeGreaterThanOrEqual(0);
		expect(output.indexOf("project:")).toBeLessThan(output.indexOf("user:"));
		// Each rule is listed; the user rule carries its audit hit count.
		expect(output).toContain("dyn1");
		expect(output).toContain("proj1");
		expect(output).toContain("user1");
		expect(output).toContain("[1 audit hit]");
	});
});

describe("runPermissionCommand add/remove/edit", () => {
	it("add validates the yaml and persists the rule to the user file", async () => {
		const output = await runPermissionCommand(
			"add tool: bash\nmatch: { command: 'npm test' }\naction: allow",
			await ctx(),
		);
		expect(output).toContain("Added rule");

		const { rules } = loadRuleLayers(cwd, home);
		expect(rules.filter(rule => rule.layer === "user")).toHaveLength(1);
		expect(rules[0].tool).toBe("bash");
		expect(rules[0].action).toBe("allow");
	});

	it("rejects invalid yaml without persisting anything", async () => {
		const output = await runPermissionCommand("add tool: bash", await ctx());
		expect(output).toMatch(/Invalid rule/);

		expect(loadRuleLayers(cwd, home).rules.filter(rule => rule.layer === "user")).toHaveLength(0);
		expect(fs.existsSync(userRulesFile)).toBe(false);
	});

	it("remove deletes the rule from the user file", async () => {
		await runPermissionCommand("add tool: bash\nmatch: { command: 'git *' }\naction: allow\nid: git1", await ctx());
		expect(loadRuleLayers(cwd, home).rules.some(rule => rule.id === "git1")).toBe(true);

		const output = await runPermissionCommand("remove git1", await ctx());
		expect(output).toContain('Removed rule "git1"');

		expect(loadRuleLayers(cwd, home).rules.some(rule => rule.id === "git1")).toBe(false);
	});

	it("remove of an unknown id reports it without creating the user file", async () => {
		const output = await runPermissionCommand("remove missing-rule", await ctx());
		expect(output).toContain('No rule with id "missing-rule"');
		expect(fs.existsSync(userRulesFile)).toBe(false);
	});

	it("edit replaces a user-layer rule by id", async () => {
		await runPermissionCommand("add tool: bash\nmatch: { command: 'git *' }\naction: allow\nid: git1", await ctx());

		const output = await runPermissionCommand(
			"edit git1 tool: bash\nmatch: { command: 'git push' }\naction: deny",
			await ctx(),
		);
		expect(output).toContain('Updated rule "git1"');

		const { rules } = loadRuleLayers(cwd, home);
		const rule = rules.find(candidate => candidate.id === "git1");
		expect(rule?.action).toBe("deny");
		expect(rule?.match).toEqual({ command: "git push" });
	});

	it("remove accepts multiple ids, removing each and reporting misses", async () => {
		await runPermissionCommand("add tool: bash\nmatch: { command: 'git *' }\naction: allow\nid: git1", await ctx());
		await runPermissionCommand("add tool: bash\nmatch: { command: 'npm *' }\naction: allow\nid: npm1", await ctx());

		const output = await runPermissionCommand("remove git1 missing1 npm1", await ctx());

		expect(output).toContain('Removed rule "git1"');
		expect(output).toContain('Removed rule "npm1"');
		expect(output).toContain('No rule with id "missing1"');
		const remaining = loadRuleLayers(cwd, home).rules;
		expect(remaining.some(rule => rule.id === "git1")).toBe(false);
		expect(remaining.some(rule => rule.id === "npm1")).toBe(false);
	});

	it("remove deletes a remembered rule from the user file", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("remove dyn1", await ctx());

		expect(output).toContain('Removed rule "dyn1" from the user layer.');
		expect(loadRuleLayers(cwd, home).rules.some(rule => rule.id === "dyn1")).toBe(false);
	});

	it("remove refuses project rules until --project is passed", async () => {
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("remove proj1", await ctx());

		expect(output).toContain("project layer (repo-committed)");
		expect(output).toContain("--project");
		expect(loadRuleLayers(cwd, home).rules.some(rule => rule.id === "proj1")).toBe(true);
	});

	it("remove --project deletes project rules", async () => {
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("remove --project proj1", await ctx());

		expect(output).toContain('Removed rule "proj1" from the project layer.');
		expect(loadRuleLayers(cwd, home).rules.some(rule => rule.id === "proj1")).toBe(false);
	});

	it("remove --project handles mixed personal and project ids", async () => {
		await runPermissionCommand("add tool: bash\nmatch: { command: 'git *' }\naction: allow\nid: git1", await ctx());
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("remove git1 --project proj1", await ctx());

		expect(output).toContain('Removed rule "git1" from the user layer.');
		expect(output).toContain('Removed rule "proj1" from the project layer.');
		expect(loadRuleLayers(cwd, home).rules).toHaveLength(0);
	});
});

describe("runPermissionCommand clear", () => {
	it("wipes user rules, reporting what was cleared", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("clear", await ctx());

		expect(output).toContain("Cleared user (2)");
		const { rules } = loadRuleLayers(cwd, home);
		expect(rules.filter(rule => rule.layer === "user")).toHaveLength(0);
	});

	it("clear also wipes rules folded from a legacy dynamic file", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: old1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("clear", await ctx());

		expect(output).toContain("Cleared user (2)");
		expect(fs.existsSync(path.join(home, ".omp", "agent", "permissions.dynamic.yml"))).toBe(false);
		expect(loadRuleLayers(cwd, home).rules.filter(rule => rule.layer === "user")).toHaveLength(0);
	});

	it("leaves repo-committed project rules until --project is passed", async () => {
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("clear", await ctx());

		// User layer is still wiped; the project rules are listed and kept.
		expect(output).toContain("Cleared user (1)");
		expect(output).toContain("Project layer has 1 repo-committed rule");
		expect(output).toContain("proj1");
		expect(output).toContain('Re-run "permissions clear --project"');
		const { rules } = loadRuleLayers(cwd, home);
		expect(rules.filter(rule => rule.layer === "user")).toHaveLength(0);
		expect(rules.filter(rule => rule.layer === "project")).toHaveLength(1);
	});

	it("clear --project wipes the project layer too", async () => {
		write(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("clear --project", await ctx());

		expect(output).toContain("Cleared user (1), project (1)");
		expect(loadRuleLayers(cwd, home).rules).toHaveLength(0);
	});

	it("reports when there is nothing to clear", async () => {
		const output = await runPermissionCommand("clear", await ctx());
		expect(output).toContain("No file-backed rules to clear");
		expect(fs.existsSync(userRulesFile)).toBe(false);
	});

	it("rejects unknown flags", async () => {
		const output = await runPermissionCommand("clear --force", await ctx());
		expect(output).toContain('Unknown flag "--force"');
	});
});

describe("runPermissionCommand test", () => {
	it("dry-runs a bash command and reports the deciding rule and layer without writing anything", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: git1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);

		const output = await runPermissionCommand('test "git status"', await ctx());

		expect(output).toContain("decision: allow");
		expect(output).toContain("rule: git1");
		expect(output).toContain("layer: user");
		// Dry-run purity: the audit log and rule files are untouched.
		expect(fs.existsSync(auditFilePath(cwd))).toBe(false);
	});

	it("reports posture prompts when no rule matches", async () => {
		const output = await runPermissionCommand('test "git status"', await ctx());
		expect(output).toContain("decision: prompt");
	});

	it("test output includes match class and specificity winner", async () => {
		// temp user file: deny bash "* |head *", allow bash "git branch * |head *"
		// (normalized pipe forms: the tokenizer glues `|` to the next stage).
		// The git stage must be rule-allowed too: git is not a safe-consumer
		// stage, so an unruled stage would degrade the pipeline allow to a prompt.
		write(
			userRulesFile,
			"rules:\n  - id: deny-pipe\n    tool: bash\n    match: { command: '* |head *' }\n    action: deny\n  - id: allow-git-pipe\n    tool: bash\n    match: { command: 'git branch * |head *' }\n    action: allow\n  - id: allow-git-branch\n    tool: bash\n    match: { command: 'git branch *' }\n    action: allow\n",
		);

		const output = await runPermissionCommand('test "git branch -a | head -20"', await ctx());

		// The exact-structure allow (specificity 3: git, branch, |head) beats the
		// general pipe deny (specificity 1) and the covering stage allow, so it
		// decides.
		expect(output).toContain("decision: allow");
		expect(output).toContain("class: exact-structure (specificity 3)");
		expect(output).toContain("allow-git-pipe");
		expect(output).toContain("resolved: allow-git-pipe beats 2 other matches");
	});

	it("omits class/resolved when the whole-command winner did not decide (curated hard-deny)", async () => {
		// A file-backed allow matches, but the curated critical pattern decides
		// (no ruleId): the annotations would describe a rule that did not
		// decide, so they must be omitted.
		write(
			userRulesFile,
			"rules:\n  - id: allow-rm\n    tool: bash\n    match: { command: 'rm -rf /' }\n    action: allow\n",
		);

		const output = await runPermissionCommand('test "rm -rf /"', await ctx());

		expect(output).toContain("decision: deny");
		expect(output).not.toContain("class:");
		expect(output).not.toContain("resolved:");
	});

	it("prints the piece-level deciding rule's class and specificity", async () => {
		// A compound whose deny decided at the piece level (no whole-command
		// winner) still attributes class/specificity to the deciding piece rule.
		write(
			userRulesFile,
			"rules:\n  - id: deny-echo\n    tool: bash\n    match: { command: 'echo *' }\n    action: deny\n",
		);

		const output = await runPermissionCommand('test "git log -n 5 && echo hi"', await ctx());

		expect(output).toContain("decision: deny");
		expect(output).toContain("piece: echo hi -> deny (deny-echo, user)");
		expect(output).toContain("piece class: exact-structure (specificity 1)");
		// No whole-command winner exists for this compound: the plain class
		// line stays absent.
		expect(output).not.toContain("\nclass:");
	});
});

describe("runPermissionCommand status/log/migrate", () => {
	it("status shows the configured posture and rule file paths", async () => {
		write(path.join(agentDir, "config.yml"), YAML.stringify({ permissions: { default: "allow" } }, null, 2));
		write(
			userRulesFile,
			"rules:\n  - id: user1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);

		const output = await runPermissionCommand("status", await ctx());

		expect(output).toContain("Posture: allow");
		expect(output).toContain("project: 0");
		expect(output).toContain("user: 1");
		expect(output).toContain(userRulesFile);
	});

	it("log prints recent audit entries newest-first", async () => {
		const file = auditFilePath(cwd);
		await appendAudit(file, { ts: 1000, tool: "bash", command: "old", decision: "prompt" });
		await appendAudit(file, { ts: 2000, tool: "bash", command: "new", decision: "allow" });

		const output = await runPermissionCommand("log", await ctx());

		expect(output.indexOf("new")).toBeLessThan(output.indexOf("old"));
		expect(output).toContain("allow");
	});

	it("migrate dry-runs the plan without applying it", async () => {
		write(path.join(agentDir, "config.yml"), YAML.stringify({ tools: { approval: { bash: "allow" } } }, null, 2));

		const output = await runPermissionCommand("migrate", await ctx());

		expect(output).toContain("Migration plan");
		expect(output).toContain("tools.approval.bash: allow becomes a permission rule");
		// Dry-run: nothing written to the user rules file.
		expect(fs.existsSync(userRulesFile)).toBe(false);
	});
});

describe("permissions model tool surface", () => {
	it("rejects mutation actions at the schema level (read-only)", () => {
		expect(permissionsSchema.allows({ action: "list" })).toBe(true);
		expect(permissionsSchema.allows({ action: "test", command: "git status" })).toBe(true);
		expect(permissionsSchema.allows({ action: "add" })).toBe(false);
		expect(permissionsSchema.allows({ action: "remove" })).toBe(false);
	});

	it("rejects unknown subcommands with a usage error", async () => {
		const output = await runPermissionCommand("frobnicate", await ctx());
		expect(output).toContain('Unknown subcommand "frobnicate"');
		expect(output).toContain("Usage: permissions");
	});
});

describe("runModeCommand", () => {
	it("shows the current posture without an argument", async () => {
		const output = await runModeCommand("", await ctx());
		expect(output).toBe("Mode: prompt");
	});

	it("writes each posture to permissions.default", async () => {
		for (const mode of ["allow", "prompt", "deny"] as const) {
			const c = await ctx();
			const output = await runModeCommand(mode, c);
			expect(output).toBe(`Mode set to ${mode} (permissions.default)`);
			expect(cfgPermissionsDefault.get(c.settings)).toBe(mode);
		}
	});

	it("accepts uppercase input and rejects anything else", async () => {
		const c = await ctx();
		expect(await runModeCommand("ALLOW", c)).toContain("Mode set to allow");
		const output = await runModeCommand("yolo", c);
		expect(output).toContain('Unknown mode "yolo"');
		expect(output).toContain("allow, prompt, or deny");
		expect(cfgPermissionsDefault.get(c.settings)).toBe("allow"); // untouched by the failed call
	});
});

describe("cyclePosture", () => {
	it("cycles allow → prompt → deny → allow", () => {
		expect(cyclePosture("allow")).toBe("prompt");
		expect(cyclePosture("prompt")).toBe("deny");
		expect(cyclePosture("deny")).toBe("allow");
	});
});
