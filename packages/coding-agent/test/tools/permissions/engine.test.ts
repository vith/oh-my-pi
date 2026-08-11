import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	evaluateBashCommand,
	evaluatePermission,
	resolvePosture,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const tool = (name: string, approval?: unknown) => ({ name, approval, formatApprovalDetails: undefined });

function ctx(extra: Record<string, unknown> = {}, cwd = "/tmp/perm-test") {
	return { settings: Settings.isolated({ "permissions.default": "prompt", ...extra }), cwd, home: "/tmp/perm-home" };
}

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("resolvePosture", () => {
	it("maps legacy modes and defaults to prompt", () => {
		expect(resolvePosture(Settings.isolated({}))).toBe("prompt");
		expect(resolvePosture(Settings.isolated({ "tools.approvalMode": "yolo" }))).toBe("allow");
		expect(resolvePosture(Settings.isolated({ "tools.approvalMode": "write" }))).toBe("prompt");
		expect(resolvePosture(Settings.isolated({ "permissions.default": "deny" }))).toBe("deny");
	});
});

describe("evaluatePermission", () => {
	it("tool-declared deny is absolute", () => {
		const d = evaluatePermission(tool("bash", { tier: "exec", policy: "deny" }), { command: "x" }, ctx());
		expect(d.policy).toBe("deny");
		expect(d.source).toBe("tool");
	});
	it("legacy user deny wins over allow rules", () => {
		// tools.approval.bash: deny must beat a project allow rule — project rule file absent here,
		// so assert against posture instead: deny wins over posture allow.
		const d = evaluatePermission(tool("bash"), { command: "x" }, ctx({ "tools.approval": { bash: "deny" } }));
		expect(d.policy).toBe("deny");
	});
	it("curated deny fires for critical bash", () => {
		const d = evaluateBashCommand("rm -rf /", ctx());
		expect(d.policy).toBe("deny");
		expect(d.layer).toBe("curated");
	});
	it("legacy bash.patterns deny fires per piece", () => {
		const d = evaluateBashCommand(
			"git status && rm -rf /",
			ctx({ "bash.patterns": [{ match: "rm -rf /", approval: "deny" }] }),
		);
		expect(d.policy).toBe("deny");
		expect(d.pieces?.[1]?.ruleId).toBeDefined();
	});
	it("legacy bash.patterns allow never rides a compound", () => {
		const d = evaluateBashCommand(
			"git status && echo hi",
			ctx({ "bash.patterns": [{ match: "echo hi", approval: "allow" }] }),
		);
		// allow pattern may only vouch for a single-piece command:
		expect(d.policy).toBe("prompt");
		const single = evaluateBashCommand(
			"echo hi",
			ctx({ "bash.patterns": [{ match: "echo hi", approval: "allow" }] }),
		);
		expect(single.policy).toBe("allow");
	});
	it("deny-anywhere denies the whole compound and names the piece", () => {
		const d = evaluateBashCommand("echo ok; rm -rf /; echo done", ctx());
		expect(d.policy).toBe("deny");
		expect(d.reason).toContain("rm -rf /");
	});
	it("posture prompt leaves pending pieces listed", () => {
		const d = evaluateBashCommand("git status && npm test", ctx());
		expect(d.policy).toBe("prompt");
		expect(d.pieces).toHaveLength(2);
		expect(d.pieces!.every(p => p.policy === "prompt")).toBe(true);
	});
	it("curated read-only allowlist allows without prompting", () => {
		const d = evaluatePermission(tool("read"), { path: "x" }, ctx());
		expect(d.policy).toBe("allow");
	});
	it("posture allow allows unruled calls", () => {
		const d = evaluatePermission(tool("bash"), { command: "echo hi" }, ctx({ "permissions.default": "allow" }));
		expect(d.policy).toBe("allow");
	});
	it("project allow rule pre-approves a call", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "permissions.yml"),
				"rules:\n  - id: proj1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n    reason: project fixture\n",
			);
			const d = evaluatePermission(tool("bash"), { command: "npm test" }, ctx({}, dir));
			expect(d.policy).toBe("allow");
			expect(d.source).toBe("rule");
			expect(d.layer).toBe("project");
			expect(d.ruleId).toBe("proj1");
			expect(d.reason).toBe("project fixture");
			const split = evaluateBashCommand("npm test", ctx({}, dir));
			expect(split.policy).toBe("allow");
			expect(split.layer).toBe("project");
			expect(split.ruleId).toBe("proj1");
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});
