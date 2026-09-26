import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { matchRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	applyMigration,
	firstRunNotice,
	type MigrationPlan,
	planMigration,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/migrate";
import { loadRuleLayers } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import { cfgPermissionsDefault } from "@oh-my-pi/pi-coding-agent/tools/permissions/settings";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgBashPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `perm-migrate-${Snowflake.next()}-`));
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
	// firstRunNotice resolves rule files against the OS home; point it at the
	// temp home so the real user's rules never leak into the plan.
	vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
	clearFsCache();
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
});

afterAll(() => {
	removeSyncWithRetries(tmp);
});

/** Config.yml carrying all three legacy permission families. */
function writeLegacyConfig(): void {
	fs.writeFileSync(
		path.join(agentDir, "config.yml"),
		YAML.stringify(
			{
				tools: {
					approvalMode: "write",
					approval: { bash: "deny", read: "allow" },
				},
				bash: {
					patterns: [
						{ match: "git push", approval: "allow" },
						{ match: "rm -rf", approval: "deny" },
					],
				},
			},
			null,
			2,
		),
	);
}

/** Parse every planned rule into a comparable record carrying its layer. */
function plannedRules(plan: MigrationPlan): Array<Record<string, unknown>> {
	return plan.rules.map(rule => ({ ...(YAML.parse(rule.yaml) as Record<string, unknown>), layer: rule.layer }));
}

describe("planMigration", () => {
	it("maps legacy settings into rules, removals, and notices without writing anything", async () => {
		writeLegacyConfig();
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);

		expect(plan.removeSettings).toEqual(["tools.approvalMode", "tools.approval", "bash.patterns"]);

		// approvalMode "write" maps to posture "prompt" and seeds the new key
		// (permissions.default is not configured), so the hidden legacy key
		// stops governing posture after removal.
		expect(plan.postureSetting).toEqual({ value: "prompt" });

		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash-0",
			tool: "bash",
			match: { arg: "*" },
			action: "deny",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-read-1",
			tool: "read",
			match: { arg: "*" },
			action: "allow",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash-2",
			tool: "bash",
			match: { command: "git push" },
			action: "allow",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash-3",
			tool: "bash",
			match: { command: "rm -rf" },
			action: "deny",
			layer: "user",
		});

		// notices cover the approvalMode -> permissions.default mapping, the
		// per-tool and bash.patterns migrations, and the key removal.
		expect(plan.notices.some(notice => notice.includes("permissions.default"))).toBe(true);
		expect(plan.notices.some(notice => notice.includes("tools.approval.bash"))).toBe(true);
		expect(plan.notices.some(notice => notice.includes("bash.patterns"))).toBe(true);
		expect(plan.notices.some(notice => notice.includes("removed"))).toBe(true);

		// dry run: no rule file written, config untouched.
		expect(fs.existsSync(userRulesFile)).toBe(false);
		const config = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		expect((config.tools as Record<string, unknown>).approval).toBeDefined();
	});

	it("flags /…/-wrapped bash.patterns entries and preserves their glob-literal semantics", async () => {
		// Pre-engine approval treated `/npm test/` as literal glob text (it
		// never matched); the engine would reinterpret the wrapper as a regex.
		// The migrated rule keeps the legacy semantics and the plan flags it.
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					bash: {
						patterns: [{ match: "/npm test/", approval: "allow" }],
					},
				},
				null,
				2,
			),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(plan.notices.some(notice => notice.includes("/npm test/") && notice.includes("/…/-wrapped"))).toBe(true);
		const rule = plannedRules(plan).find(candidate => candidate.tool === "bash");
		expect(rule?.match).toEqual({ command: "\\/npm test\\/" });
	});

	it("plans nothing for a clean config", async () => {
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(plan.rules).toEqual([]);
		expect(plan.removeSettings).toEqual([]);
		expect(plan.notices).toEqual([]);
		expect(plan.postureSetting).toBeUndefined();
		expect(firstRunNotice(settings)).toBeNull();
	});

	it("does not overwrite an explicitly configured permissions.default when consuming approvalMode", async () => {
		// An explicit permissions.default wins over the legacy key at decision
		// time (resolvePosture), so migration must not seed over it.
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ tools: { approvalMode: "yolo" }, permissions: { default: "prompt" } }, null, 2),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);

		expect(plan.postureSetting).toBeUndefined();
		expect(plan.removeSettings).toEqual(["tools.approvalMode"]);
		// the notice explains that the explicit setting wins
		expect(plan.notices.some(notice => notice.includes("already configured"))).toBe(true);

		await applyMigration(plan, cwd, home);
		const config = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		expect(config.permissions).toEqual({ default: "prompt" });
		// removal prunes the emptied `tools` parent entirely
		expect(config.tools).toBeUndefined();
		expect(cfgPermissionsDefault.get(settings)).toBe("prompt");
	});

	it("notices a legacy dynamic file that applyMigration will fold", async () => {
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: old1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(
			plan.notices.some(notice => notice.includes("legacy dynamic") && notice.includes("1 remembered rule")),
		).toBe(true);
	});

	it("excludes legacy keys that live in a project layer from removal, with a notice", async () => {
		// Legacy key arrives via the project settings capability (.claude/settings.json),
		// not the global agentDir config.yml.
		fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".claude", "settings.json"),
			JSON.stringify({ tools: { approval: { bash: "deny" } } }),
		);

		const settings = await Settings.init({ agentDir, cwd });
		expect(settings.isConfigured(cfgToolsApproval)).toBe(true);

		const plan = planMigration(settings, cwd, home);
		// The rule is still planned from the merged value, but the key is not
		// claimed as removable: Settings.set writes only the global layer.
		expect(plannedRules(plan)).toEqual([
			{ id: "legacy-bash-0", tool: "bash", match: { arg: "*" }, action: "deny", layer: "user" },
		]);
		expect(plan.removeSettings).toEqual([]);
		expect(plan.notices.some(notice => notice.includes("outside config.yml"))).toBe(true);

		await applyMigration(plan, cwd, home);
		// the project source survives, and the plan keeps flagging it
		const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect((projectConfig.tools as Record<string, unknown>).approval).toBeDefined();
		expect(planMigration(settings, cwd, home).notices.some(notice => notice.includes("outside config.yml"))).toBe(
			true,
		);
	});

	it("skips approval entries whose policy cannot be mapped", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ tools: { approval: { bash: "always", read: "allow" } } }, null, 2),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(plannedRules(plan)).toEqual([
			{ id: "legacy-read-0", tool: "read", match: { arg: "*" }, action: "allow", layer: "user" },
		]);
		expect(plan.removeSettings).toEqual(["tools.approval"]);
	});
});

describe("applyMigration", () => {
	it("merges migrated rules into the user file (preserving existing ids) and removes legacy keys", async () => {
		writeLegacyConfig();
		fs.mkdirSync(path.dirname(userRulesFile), { recursive: true });
		fs.writeFileSync(
			userRulesFile,
			YAML.stringify(
				{ rules: [{ id: "keep-me", tool: "read", match: { path: "src/**" }, action: "allow" }] },
				null,
				2,
			),
		);

		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		await applyMigration(plan, cwd, home);

		const { rules, errors } = loadRuleLayers(cwd, home);
		expect(errors).toEqual([]);

		// the pre-existing user rule survives with its id intact
		const existing = rules.find(rule => rule.id === "keep-me");
		expect(existing?.action).toBe("allow");

		// every migrated rule is present exactly once in the user layer
		const migratedIds = ["legacy-bash-0", "legacy-read-1", "legacy-bash-2", "legacy-bash-3"];
		expect(rules.filter(rule => migratedIds.includes(rule.id))).toHaveLength(4);

		// catch-all rules match any arguments through the engine matcher
		const bashDeny = rules.find(rule => rule.id === "legacy-bash-0")!;
		expect(matchRule(bashDeny, "bash", { command: "anything at all" })).toBe(true);
		expect(matchRule(bashDeny, "read", {})).toBe(false);

		// legacy keys are gone from the config file
		const config = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		const tools = config.tools as Record<string, unknown> | undefined;
		const bash = config.bash as Record<string, unknown> | undefined;
		expect(tools?.approval).toBeUndefined();
		expect(tools?.approvalMode).toBeUndefined();
		expect(bash?.patterns).toBeUndefined();

		// and from the live settings instance
		expect(settings.isConfigured(cfgToolsApproval)).toBe(false);
		expect(settings.isConfigured(cfgToolsApprovalMode)).toBe(false);
		expect(settings.isConfigured(cfgBashPatterns)).toBe(false);

		// the mapped posture was seeded into the new, UI-visible setting
		expect(settings.isConfigured(cfgPermissionsDefault)).toBe(true);
		expect(cfgPermissionsDefault.get(settings)).toBe("prompt");
		expect(config.permissions).toEqual({ default: "prompt" });
	});

	it("keeps distinct rules when legacy entries slug identically", async () => {
		// A per-tool policy and a bash.patterns entry both matching "*" must
		// produce two distinct rules (id scheme is injective by plan index) —
		// likewise case variants of one pattern, which the legacy matcher
		// treated as separate ordered rules.
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					tools: { approval: { bash: "deny" } },
					bash: {
						patterns: [
							{ match: "*", approval: "deny" },
							{ match: "GIT PUSH", approval: "allow" },
							{ match: "git push", approval: "deny" },
						],
					},
				},
				null,
				2,
			),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);

		expect(plannedRules(plan).map(rule => rule.id)).toEqual([
			"legacy-bash-0", // tools.approval.bash (arg "*")
			"legacy-bash-1", // pattern "*"
			"legacy-bash-2", // pattern "GIT PUSH"
			"legacy-bash-3", // pattern "git push"
		]);

		await applyMigration(plan, cwd, home);
		const { rules } = loadRuleLayers(cwd, home);
		const byId = new Map(rules.map(rule => [rule.id, rule]));
		expect(byId.get("legacy-bash-0")?.action).toBe("deny");
		expect(byId.get("legacy-bash-1")?.match).toEqual({ command: "*" });
		expect(byId.get("legacy-bash-2")?.action).toBe("allow");
		expect(byId.get("legacy-bash-3")?.action).toBe("deny");
		expect(byId.size).toBe(4);
	});

	it("folds a legacy dynamic file into the user file and removes it", async () => {
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: old1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);
		fs.writeFileSync(
			userRulesFile,
			YAML.stringify(
				{ rules: [{ id: "keep-me", tool: "read", match: { path: "src/**" }, action: "allow" }] },
				null,
				2,
			),
		);

		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		await applyMigration(plan, cwd, home);

		const userRules = loadRuleLayers(cwd, home).rules.filter(rule => rule.layer === "user");
		expect(userRules.map(rule => rule.id)).toEqual(["keep-me", "old1"]);
		expect(fs.existsSync(path.join(home, ".omp", "agent", "permissions.dynamic.yml"))).toBe(false);
	});

	it("refuses to apply before settings are initialized, without writing rules", async () => {
		// beforeEach already reset the singleton; never init here.
		const plan: MigrationPlan = {
			rules: [
				{
					yaml: YAML.stringify({ id: "x", tool: "bash", match: { command: "x" }, action: "allow" }),
					layer: "user",
				},
			],
			removeSettings: ["tools.approval"],
			notices: [],
		};
		await expect(applyMigration(plan, cwd, home)).rejects.toThrow(/not initialized/);
		expect(fs.existsSync(userRulesFile)).toBe(false);
	});

	it("is idempotent: a second plan is empty and re-applying does not duplicate rules", async () => {
		writeLegacyConfig();
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);

		await applyMigration(plan, cwd, home);

		expect(planMigration(settings, cwd, home).notices).toEqual([]);
		expect(planMigration(settings, cwd, home).rules).toEqual([]);

		// re-applying the original plan replaces by id instead of duplicating
		await applyMigration(plan, cwd, home);
		const doc = YAML.parse(fs.readFileSync(userRulesFile, "utf8")) as { rules: Array<{ id: string }> };
		const ids = doc.rules.map(rule => rule.id);
		for (const id of ["legacy-bash-0", "legacy-read-1", "legacy-bash-2", "legacy-bash-3"]) {
			expect(ids.filter(candidate => candidate === id)).toHaveLength(1);
		}
	});

	it("a fresh settings load after apply sees a clean config", async () => {
		writeLegacyConfig();
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		await applyMigration(plan, cwd, home);

		resetSettingsForTest();
		const reloaded = await Settings.init({ agentDir, cwd });
		expect(reloaded.isConfigured(cfgToolsApproval)).toBe(false);
		expect(reloaded.isConfigured(cfgToolsApprovalMode)).toBe(false);
		expect(reloaded.isConfigured(cfgBashPatterns)).toBe(false);
		expect(reloaded.isConfigured(cfgPermissionsDefault)).toBe(true);
		expect(cfgPermissionsDefault.get(reloaded)).toBe("prompt");
		expect(firstRunNotice(reloaded)).toBeNull();
	});
});

describe("firstRunNotice", () => {
	it("reports mapping notices while legacy keys remain", async () => {
		writeLegacyConfig();
		const settings = await Settings.init({ agentDir, cwd });
		const notices = firstRunNotice(settings);
		expect(notices).not.toBeNull();
		expect(notices?.some(notice => notice.includes("permissions.default"))).toBe(true);
		expect(notices?.some(notice => notice.includes("removed"))).toBe(true);
	});
});
