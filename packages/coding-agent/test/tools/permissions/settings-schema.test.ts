import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("permissions settings", () => {
	it("defaults to prompt posture with suggestions off and project writes inherited", () => {
		const s = Settings.isolated({});
		expect(s.get("permissions.default")).toBe("prompt");
		expect(s.get("permissions.llmSuggestions")).toBe(false);
		expect(s.get("permissions.projectWrites")).toBe("prompt");
		expect(s.get("permissions.audit.enabled")).toBe(true);
		expect(s.get("permissions.audit.maxEntries")).toBe(10000);
	});
	it("accepts overrides", () => {
		const s = Settings.isolated({
			"permissions.default": "deny",
			"permissions.llmSuggestions": true,
			"permissions.projectWrites": "allow",
			"permissions.audit.maxEntries": 5,
		});
		expect(s.get("permissions.default")).toBe("deny");
		expect(s.get("permissions.llmSuggestions")).toBe(true);
		expect(s.get("permissions.projectWrites")).toBe("allow");
		expect(s.get("permissions.audit.maxEntries")).toBe(5);
	});
});
