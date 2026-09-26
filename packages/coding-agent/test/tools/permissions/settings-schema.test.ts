import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgPermissionsAuditEnabled,
	cfgPermissionsAuditMaxEntries,
	cfgPermissionsDefault,
	cfgPermissionsLlmSuggestions,
	cfgPermissionsProjectWrites,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/settings";

describe("permissions settings", () => {
	it("defaults to prompt posture with suggestions off and project writes inherited", () => {
		const s = Settings.isolated({});
		expect(cfgPermissionsDefault.get(s)).toBe("prompt");
		expect(cfgPermissionsLlmSuggestions.get(s)).toBe(false);
		expect(cfgPermissionsProjectWrites.get(s)).toBe("prompt");
		expect(cfgPermissionsAuditEnabled.get(s)).toBe(true);
		expect(cfgPermissionsAuditMaxEntries.get(s)).toBe(10000);
	});
	it("accepts overrides", () => {
		const s = Settings.isolated({
			"permissions.default": "deny",
			"permissions.llmSuggestions": true,
			"permissions.projectWrites": "allow",
			"permissions.audit.maxEntries": 5,
		});
		expect(cfgPermissionsDefault.get(s)).toBe("deny");
		expect(cfgPermissionsLlmSuggestions.get(s)).toBe(true);
		expect(cfgPermissionsProjectWrites.get(s)).toBe("allow");
		expect(cfgPermissionsAuditMaxEntries.get(s)).toBe(5);
	});
});
