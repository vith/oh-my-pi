import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { matchRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	applyMigration,
	firstRunNotice,
	type MigrationPlan,
	planMigration,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/migrate";
import { loadRuleLayers } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
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
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
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

		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash",
			tool: "bash",
			match: { arg: "*" },
			action: "deny",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-read",
			tool: "read",
			match: { arg: "*" },
			action: "allow",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash-git-push",
			tool: "bash",
			match: { command: "git push" },
			action: "allow",
			layer: "user",
		});
		expect(plannedRules(plan)).toContainEqual({
			id: "legacy-bash-rm-rf",
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

	it("plans nothing for a clean config", async () => {
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(plan.rules).toEqual([]);
		expect(plan.removeSettings).toEqual([]);
		expect(plan.notices).toEqual([]);
		expect(firstRunNotice(settings)).toBeNull();
	});

	it("skips approval entries whose policy cannot be mapped", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ tools: { approval: { bash: "always", read: "allow" } } }, null, 2),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const plan = planMigration(settings, cwd, home);
		expect(plannedRules(plan)).toEqual([
			{ id: "legacy-read", tool: "read", match: { arg: "*" }, action: "allow", layer: "user" },
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
		const migratedIds = ["legacy-bash", "legacy-read", "legacy-bash-git-push", "legacy-bash-rm-rf"];
		expect(rules.filter(rule => migratedIds.includes(rule.id))).toHaveLength(4);

		// catch-all rules match any arguments through the engine matcher
		const bashDeny = rules.find(rule => rule.id === "legacy-bash")!;
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
		expect(settings.isConfigured("tools.approval")).toBe(false);
		expect(settings.isConfigured("tools.approvalMode")).toBe(false);
		expect(settings.isConfigured("bash.patterns")).toBe(false);
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
		for (const id of ["legacy-bash", "legacy-read", "legacy-bash-git-push", "legacy-bash-rm-rf"]) {
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
		expect(reloaded.isConfigured("tools.approval")).toBe(false);
		expect(reloaded.isConfigured("tools.approvalMode")).toBe(false);
		expect(reloaded.isConfigured("bash.patterns")).toBe(false);
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
