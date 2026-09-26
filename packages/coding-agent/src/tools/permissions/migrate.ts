import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { settings as globalSettings, isSettingsInitialized, type Settings } from "../../config/settings";
import type { AnySetting } from "../../config/registry";
import { type ApprovalPolicy, normalizePolicy } from "../approval";
import { normalizeBashApprovalPattern } from "../bash";
import { cfgBashPatterns } from "../../exec/settings";
import { cfgToolsApproval, cfgToolsApprovalMode } from "../settings";
import { legacyBashPattern, type Posture, postureFromApprovalMode } from "./engine";
import { cfgPermissionsDefault } from "./settings";
import { foldLegacyDynamicRules, type RuleAction, ruleFiles, writeUserRule } from "./rules";

/**
 * One-shot migration of legacy permission settings (`tools.approvalMode`,
 * `tools.approval.*`, `bash.patterns`) into engine rule files.
 *
 * v1 layer decision: migrated rules always land in the **user** file
 * (`~/.omp/agent/permissions.yml`), regardless of which config layer held the
 * legacy keys. The engine gives user-layer rules a stable home for
 * hand-editing, and the deterministic, injective `legacy-<tool>-<index>` ids
 * (index = position in the ordered plan) make re-applying the same plan
 * replace rather than duplicate — even when two legacy entries slug to the
 * same text (e.g. a per-tool policy and a `bash.patterns` entry matching
 * `*`, or case variants of one pattern).
 *
 * Key removal is scoped to the global config layer: keys that only exist in a
 * project or runtime settings layer cannot be removed through
 * `unsetGlobalValue` (which edits the global layer), so they are excluded from
 * `removeSettings` and flagged with a notice instead.
 */

export interface MigrationPlan {
	/** Rules to write, serialized exactly as they will be merged into the file. */
	rules: Array<{ yaml: string; layer: "project" | "user" }>;
	/** Legacy settings keys to remove from config, present only when configured. */
	removeSettings: string[];
	/** User-facing mapping notices describing the dry run. */
	notices: string[];
	/**
	 * `permissions.default` value to write when a legacy `tools.approvalMode`
	 * is consumed and the new key is not explicitly configured. Seeding the new
	 * setting with the mapped posture keeps the legacy behavior after the key
	 * is removed and makes the posture visible/editable in the settings UI
	 * (the legacy key is config-file-only and hidden).
	 */
	postureSetting?: { value: Posture };
}

const LEGACY_APPROVAL_MODE = "tools.approvalMode";
const LEGACY_APPROVAL = "tools.approval";
const LEGACY_BASH_PATTERNS = "bash.patterns";

/**
 * Dry-run migration: derive rules, key removals, and notices from the current
 * settings without touching any file.
 */
export function planMigration(settings: Settings, cwd: string, home?: string): MigrationPlan {
	const rules: MigrationPlan["rules"] = [];
	const removeSettings: string[] = [];
	const notices: string[] = [];
	let postureSetting: MigrationPlan["postureSetting"];
	// Position in the ordered plan; makes rule ids injective and deterministic.
	let ruleIndex = 0;

	// A configured key only belongs in removeSettings when the global config
	// layer (agentDir/config.yml) holds it: Settings.set writes #global, so
	// keys living solely in a project/runtime layer would survive removal,
	// keep the plan non-empty, and break idempotency. Those are excluded and
	// flagged with a notice instead.
	const removalOwned = (key: string): boolean => globalConfigHasKey(settings, key);

	if (settings.isConfigured(cfgToolsApprovalMode)) {
		const mode = cfgToolsApprovalMode.get(settings);
		if (removalOwned(LEGACY_APPROVAL_MODE)) {
			removeSettings.push(LEGACY_APPROVAL_MODE);
		} else {
			notices.push(notOwnedNotice(LEGACY_APPROVAL_MODE));
		}
		// The legacy key is hidden from the settings UI but still governs the
		// engine posture (resolvePosture consults it), so removing it without
		// seeding permissions.default would silently flip the posture to
		// "prompt". Seed the new key with the mapped posture unless the user
		// already configured it — an explicit permissions.default wins over the
		// legacy key at decision time and must not be overwritten.
		const posture = postureFromApprovalMode(mode);
		if (posture !== undefined) {
			if (settings.isConfigured(cfgPermissionsDefault)) {
				notices.push(
					`tools.approvalMode: ${mode} maps to permissions.default: ${posture}; permissions.default is already configured and takes precedence, so it is left unchanged.`,
				);
			} else {
				postureSetting = { value: posture };
				notices.push(
					`tools.approvalMode: ${mode} maps to permissions.default: ${posture}. Migration sets permissions.default to ${posture} so the posture survives the legacy key's removal — change it in settings at any time.`,
				);
			}
		}
	}

	if (settings.isConfigured(cfgToolsApproval)) {
		const approval = cfgToolsApproval.get(settings);
		if (removalOwned(LEGACY_APPROVAL)) {
			removeSettings.push(LEGACY_APPROVAL);
		} else {
			notices.push(notOwnedNotice(LEGACY_APPROVAL));
		}
		if (approval !== null && typeof approval === "object" && !Array.isArray(approval)) {
			for (const [toolName, rawPolicy] of Object.entries(approval as Record<string, unknown>)) {
				const policy = normalizePolicy(rawPolicy);
				if (policy === undefined) continue; // unmappable entries are left out of the plan
				rules.push(makeRule(toolName, { arg: "*" }, policy, ruleIndex++));
				notices.push(
					`tools.approval.${toolName}: ${policy} becomes a permission rule (tool: ${toolName}, any arguments, action: ${policy}).`,
				);
			}
		}
	}

	if (settings.isConfigured(cfgBashPatterns)) {
		const patterns = cfgBashPatterns.get(settings);
		if (removalOwned(LEGACY_BASH_PATTERNS)) {
			removeSettings.push(LEGACY_BASH_PATTERNS);
		} else {
			notices.push(notOwnedNotice(LEGACY_BASH_PATTERNS));
		}
		if (Array.isArray(patterns)) {
			for (const item of patterns) {
				if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
				const record = item as Record<string, unknown>;
				const match = typeof record.match === "string" ? normalizeBashApprovalPattern(record.match) : undefined;
				const policy = normalizePolicy(record.approval);
				if (match === undefined || match.length === 0 || policy === undefined) continue;
				// A /…/-wrapped legacy pattern was glob-literal (and inert) under
				// the pre-engine approval path; permission rules would reinterpret
				// it as an unanchored regex — a behavior change for allow rules.
				// Preserve the legacy semantics in the migrated rule and flag it.
				const regexWrapped = match.startsWith("/") && match.endsWith("/") && match.length >= 2;
				rules.push(
					makeRule("bash", { command: regexWrapped ? legacyBashPattern(match) : match }, policy, ruleIndex++),
				);
				notices.push(`bash.patterns "${match}" becomes a bash permission rule (action: ${policy}).`);
				if (regexWrapped) {
					notices.push(
						`bash.patterns "${match}" is /…/-wrapped: the pre-engine approval path treated it as literal glob text (it never matched), and the migrated rule keeps that behavior. Permission rules interpret /…/ as a regex — edit the rule if you intended regex matching.`,
					);
				}
			}
		}
	}

	if (rules.length > 0) {
		notices.push(`Migration will write ${rules.length} rule(s) to ${ruleFiles(cwd, home).user}.`);
	}
	if (removeSettings.length > 0) {
		notices.push(`Legacy settings key(s) ${removeSettings.join(", ")} will be removed from config.`);
	}
	// The pre-merge engine wrote remembered rules to a separate dynamic file.
	// The loader folds them at read time; migration physically merges the
	// file into the user file and removes it.
	const legacyFile = ruleFiles(cwd, home).legacyDynamic;
	if (fs.existsSync(legacyFile)) {
		let legacyCount = 0;
		try {
			const doc = YAML.parse(fs.readFileSync(legacyFile, "utf8")) as { rules?: unknown } | null;
			if (doc !== null && typeof doc === "object" && Array.isArray(doc.rules)) {
				legacyCount = doc.rules.length;
			}
		} catch {
			legacyCount = 0;
		}
		if (legacyCount > 0) {
			notices.push(
				`Fold ${legacyCount} remembered rule(s) from the legacy dynamic rules file (${legacyFile}) into the user rules file.`,
			);
		}
	}

	return {
		rules,
		removeSettings,
		notices,
		...(postureSetting !== undefined ? { postureSetting } : {}),
	};
}

/**
 * Apply a plan: write the rules into the user layer (merging with existing
 * rules by id) and remove the legacy settings keys. Key removal goes through
 * `unsetGlobalValue`, which deletes the key from the global layer (persisted
 * in the background) so the key disappears from the config file (and the live
 * instance stops reporting it as configured).
 */
export async function applyMigration(plan: MigrationPlan, cwd: string, home?: string): Promise<void> {
	if (!isSettingsInitialized()) {
		throw new Error(
			"Cannot apply permission migration: Settings is not initialized (Settings.init() must run first).",
		);
	}
	const userFile = ruleFiles(cwd, home).user;
	for (const rule of plan.rules) {
		const parsed = YAML.parse(rule.yaml);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Cannot apply migration: invalid rule yaml:\n${rule.yaml}`);
		}
		const record = parsed as {
			id: string;
			tool: string;
			match: Record<string, unknown>;
			action: RuleAction;
			reason?: string;
			ttl?: number;
		};
		await writeUserRule(userFile, { ...record, layer: "user" });
	}

	for (const key of plan.removeSettings) {
		removeSettingKey(key);
	}
	if (plan.postureSetting !== undefined) {
		globalSettings.writeValue(cfgPermissionsDefault, plan.postureSetting.value, "global");
	}
	await globalSettings.flush();
	// Finish the pre-merge dynamic-file transition: fold any leftover
	// remembered rules into the user file and remove the legacy file. The
	// loader already reads them as user-layer rules, so this only changes
	// where they physically live.
	await foldLegacyDynamicRules(cwd, home);
}

/** Remove a legacy key from the global layer; unknown keys are ignored. */
function removeSettingKey(key: string): void {
	const setting = legacySettingByKey(key);
	if (setting === undefined) return;
	globalSettings.unsetGlobalValue(setting);
}

/** Registry handle for a legacy settings key removed by migration. */
function legacySettingByKey(key: string): AnySetting | undefined {
	switch (key) {
		case LEGACY_APPROVAL_MODE:
			return cfgToolsApprovalMode;
		case LEGACY_APPROVAL:
			return cfgToolsApproval;
		case LEGACY_BASH_PATTERNS:
			return cfgBashPatterns;
		default:
			return undefined;
	}
}

/**
 * Build a plan rule with a deterministic, injective id
 * (`legacy-<tool>-<index>`, index = position in the ordered plan). Any two
 * legacy entries get distinct ids, so re-applying the same plan replaces
 * instead of duplicating — and a per-tool policy can never be silently
 * overwritten by a `bash.patterns` entry whose text slugs identically.
 */
function makeRule(
	tool: string,
	match: Record<string, unknown>,
	action: ApprovalPolicy,
	index: number,
): { yaml: string; layer: "user" } {
	const id = `legacy-${slugify(tool)}-${index}`;
	return { yaml: YAML.stringify({ id, tool, match, action }, null, 2), layer: "user" };
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function notOwnedNotice(key: string): string {
	return `${key} is configured outside config.yml (a project or runtime settings layer). Migration cannot remove it — delete the key from its source config after migrating.`;
}

/**
 * Whether the global config layer (agentDir/config.yml, or config.yaml when
 * config.yml is absent) holds `key`, in nested or quoted-dotted form. A
 * missing or unparseable config counts as "not present".
 */
function globalConfigHasKey(settings: Settings, key: string): boolean {
	const segments = key.split(".");
	for (const filename of MAIN_CONFIG_FILENAMES) {
		let content: string;
		try {
			content = fs.readFileSync(path.join(settings.getAgentDir(), filename), "utf8");
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch {
			return false;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const raw = parsed as Record<string, unknown>;
		if (keyInRaw(raw, segments)) return true;
		if (Object.hasOwn(raw, key)) return true; // quoted-dotted legacy form
	}
	return false;
}

function keyInRaw(raw: Record<string, unknown>, segments: readonly string[]): boolean {
	let current: unknown = raw;
	for (const segment of segments) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return false;
		const record = current as Record<string, unknown>;
		if (!Object.hasOwn(record, segment)) return false;
		current = record[segment];
	}
	return true;
}

/**
 * Mapping notices for the current session when any legacy key is present.
 * Returns `null` once the config is clean (e.g. after `applyMigration`).
 */
export function firstRunNotice(settings: Settings): string[] | null {
	const plan = planMigration(settings, process.cwd());
	return plan.notices.length > 0 ? plan.notices : null;
}
