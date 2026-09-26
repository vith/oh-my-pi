import type { Settings } from "../../config/settings";
import { register } from "../../config/registry";
import { cfgBashAllowCompoundCommands, cfgBashPatterns } from "../../exec/settings";
import { cfgToolsApproval, cfgToolsApprovalMode } from "../settings";

// Default posture for the permission engine (interaction tab, governs every tool gate).
//   "allow"  — auto-approve any call the engine does not deny.
//   "prompt" — prompt for any call not allowed by a rule (deny-by-default).
//   "deny"   — block any call not explicitly allowed by a rule.
export const cfgPermissionsDefault = register({
	id: "permissions.default",
	type: "enum",
	values: ["allow", "prompt", "deny"] as const,
	default: "prompt",
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Default Permission Posture",
		description:
			"Default posture for tool calls with no matching permission rule. 'Prompt' asks before executing; 'allow' auto-approves; 'deny' blocks.",
		options: [
			{
				value: "allow",
				label: "Allow",
				description: "Auto-approve every tool call the engine does not deny.",
			},
			{
				value: "prompt",
				label: "Prompt",
				description: "Ask before executing calls that no permission rule allows.",
			},
			{
				value: "deny",
				label: "Deny",
				description: "Block calls that no permission rule allows.",
			},
		],
	},
});

// Default posture for write tools targeting the project directory
// (interaction tab). Overrides permissions.default for write tools whose
// target path resolves inside the nearest project root; paths outside it
// keep the general posture.
export const cfgPermissionsProjectWrites = register({
	id: "permissions.projectWrites",
	type: "enum",
	values: ["allow", "prompt", "deny"] as const,
	default: "prompt",
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "Project Directory Writes",
		description:
			"Posture for write tools (edit, write) targeting paths inside the project directory, instead of the default posture. 'Allow' auto-approves project-scoped writes; 'prompt' asks; 'deny' blocks.",
		options: [
			{
				value: "allow",
				label: "Allow",
				description: "Auto-approve writes to files inside the project directory.",
			},
			{
				value: "prompt",
				label: "Prompt",
				description: "Ask before executing writes inside the project directory.",
			},
			{
				value: "deny",
				label: "Deny",
				description: "Block writes inside the project directory.",
			},
		],
	},
});

// LLM-generated permission rule suggestions (interaction tab). Defaults
// off: the extra rule options are opt-in. The model's recommended action
// for the dialog preselection always runs (auto-mode-with-confirmation).
export const cfgPermissionsLlmSuggestions = register({
	id: "permissions.llmSuggestions",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Permissions",
		label: "LLM Rule Suggestions",
		description:
			"Ask the session model to propose allow/deny rules for each pending approval. Off by default; when enabled, rules appear as extra dialog options. The model's recommended action for the preselected choice always runs.",
	},
});

// Permission audit log (persisted history of engine decisions).
export const cfgPermissionsAuditEnabled = register({
	id: "permissions.audit.enabled",
	type: "boolean",
	default: true,
});

// Rotation cap for the audit log file (newest N records kept).
export const cfgPermissionsAuditMaxEntries = register({
	id: "permissions.audit.maxEntries",
	type: "number",
	default: 10000,
});

/**
 * String-keyed settings view the permission engine evaluates against. The
 * centralized registry removed the generic `Settings.get(key: string)` surface
 * the engine was written against, so boundary call sites wrap the live
 * `Settings` with {@link engineSettingsFrom} once and the engine keeps its
 * string-keyed reads. Hand-written test doubles with `get`/`isConfigured`
 * already satisfy this interface structurally — no wrapping needed there.
 */
export interface EngineSettings {
	get(key: string): unknown;
	isConfigured(key: string): boolean;
}

/**
 * Adapt a registry `Settings` to the engine's string-keyed view. Only the
 * keys the engine reads are mapped; anything else reports
 * unconfigured/`undefined`, matching the old surface for unknown keys.
 */
export function engineSettingsFrom(settings: Settings): EngineSettings {
	return {
		get(key: string): unknown {
			switch (key) {
				case "permissions.default":
					return cfgPermissionsDefault.get(settings);
				case "permissions.projectWrites":
					return cfgPermissionsProjectWrites.get(settings);
				case "permissions.llmSuggestions":
					return cfgPermissionsLlmSuggestions.get(settings);
				case "tools.approvalMode":
					return cfgToolsApprovalMode.get(settings);
				case "tools.approval":
					return cfgToolsApproval.get(settings);
				case "bash.patterns":
					return cfgBashPatterns.get(settings);
				case "bash.allowCompoundCommands":
					return cfgBashAllowCompoundCommands.get(settings);
				case "permissions.audit.enabled":
					return cfgPermissionsAuditEnabled.get(settings);
				case "permissions.audit.maxEntries":
					return cfgPermissionsAuditMaxEntries.get(settings);
				default:
					return undefined;
			}
		},
		isConfigured(key: string): boolean {
			switch (key) {
				case "permissions.default":
					return settings.isConfigured(cfgPermissionsDefault);
				case "permissions.projectWrites":
					return settings.isConfigured(cfgPermissionsProjectWrites);
				case "permissions.llmSuggestions":
					return settings.isConfigured(cfgPermissionsLlmSuggestions);
				case "tools.approvalMode":
					return settings.isConfigured(cfgToolsApprovalMode);
				case "tools.approval":
					return settings.isConfigured(cfgToolsApproval);
				case "bash.patterns":
					return settings.isConfigured(cfgBashPatterns);
				case "bash.allowCompoundCommands":
					return settings.isConfigured(cfgBashAllowCompoundCommands);
				case "permissions.audit.enabled":
					return settings.isConfigured(cfgPermissionsAuditEnabled);
				case "permissions.audit.maxEntries":
					return settings.isConfigured(cfgPermissionsAuditMaxEntries);
				default:
					return false;
			}
		},
	};
}
