import { describe, expect, it } from "bun:test";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

// Settings stub backing BashTool.approval, which now evaluates through the
// permission engine: `get` must serve the engine's keys (bash.patterns,
// tools.approval, permissions.default, tools.approvalMode) and `isConfigured`
// must answer whether the override was explicitly set (mirrors Settings).
function createBashTool(settingsOverrides: Record<string, unknown> = {}): BashTool {
	const settings = {
		get(key: string): unknown {
			if (Object.hasOwn(settingsOverrides, key)) return settingsOverrides[key];
			switch (key) {
				case "async.enabled":
				case "bash.autoBackground.enabled":
				case "astGrep.enabled":
				case "astEdit.enabled":
				case "grep.enabled":
				case "glob.enabled":
					return false;
				case "bash.autoBackground.thresholdMs":
					return 60_000;
				default:
					return undefined;
			}
		},
		isConfigured(key: string): boolean {
			return Object.hasOwn(settingsOverrides, key);
		},
	};
	return new BashTool({
		settings,
		cwd: "/tmp/perm-test",
	} as unknown as ConstructorParameters<typeof BashTool>[0]);
}

describe("BashTool.approval through the permission engine", () => {
	it("engine denies critical compounds per piece through the tool approval fn", () => {
		const tool = createBashTool({ "permissions.default": "allow" });
		const decision = tool.approval({ command: "echo ok && rm -rf /" }) as { policy: string; reason?: string };
		expect(decision.policy).toBe("deny");
		expect(decision.reason).toContain("rm -rf /");
	});
	it("legacy bash.patterns allow still works for single commands", () => {
		const tool = createBashTool({
			"permissions.default": "prompt",
			"bash.patterns": [{ match: "echo hi", approval: "allow" }],
		});
		const decision = tool.approval({ command: "echo hi" }) as { policy: string };
		expect(decision.policy).toBe("allow");
	});
});
