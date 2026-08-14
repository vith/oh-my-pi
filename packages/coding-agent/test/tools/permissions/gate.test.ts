import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExtensionRunner, ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { auditFilePath, readAudit } from "@oh-my-pi/pi-coding-agent/tools/permissions/audit";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const blocks = result.content ?? [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

describe("wrapper approval gate resolves through the permission engine", () => {
	// The per-tool approval gate (ExtensionToolWrapper) resolves via
	// evaluatePermission with the execute-time AgentToolContext's settings. A
	// single shared session exercises every combination — we only vary the
	// context settings per assertion.
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let cwd: string;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-permission-gate-${Snowflake.next()}-`));
		cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		// Windows can briefly hold tempdir handles after session.dispose(); retry a few times.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				removeSyncWithRetries(tempDir);
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw err;
				if (attempt === 4) break; // best-effort: OS will reclaim
				await Bun.sleep(50 * (attempt + 1));
			}
		}
	});

	function approvalSettings(extraSettings: Record<string, unknown> = {}): Settings {
		return Settings.isolated({ ...BASE_SETTINGS, ...extraSettings });
	}

	function bashTool() {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		return bash;
	}

	it("engine posture prompt gates unruled exec calls (fail-closed without UI)", async () => {
		// always-ask makes the pre-engine gate prompt too; the engine assertion
		// is that an explicit permissions.default: prompt posture still prompts.
		const settings = approvalSettings({ "tools.approvalMode": "always-ask", "permissions.default": "prompt" });
		await expect(
			bashTool().execute("posture-prompt", { command: "echo blocked" }, undefined, undefined, {
				settings,
				home: tempDir,
			} as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});

	it("engine posture allow lets unruled calls through even with always-ask mode", async () => {
		// Pre-engine: always-ask prompts (no UI) and this rejects. Post-engine:
		// the explicitly configured permissions.default: allow posture wins.
		const settings = approvalSettings({ "tools.approvalMode": "always-ask", "permissions.default": "allow" });
		const result = await bashTool().execute("posture-allow", { command: "echo ok" }, undefined, undefined, {
			settings,
			home: tempDir,
		} as AgentToolContext);
		expect(textOf(result)).toContain("ok");
	});

	it("legacy yolo mode still maps to allow posture", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "yolo" });
		const result = await bashTool().execute("yolo-legacy", { command: "echo ok" }, undefined, undefined, {
			settings,
			home: tempDir,
		} as AgentToolContext);
		expect(textOf(result)).toContain("ok");
	});

	it("critical bash patterns deny even with posture allow", async () => {
		// Pre-engine: always-ask prompts instead of denying (no-UI error, no
		// execution). Post-engine: the curated critical deny outranks the
		// allow posture and surfaces the user-policy deny.
		const settings = approvalSettings({ "tools.approvalMode": "always-ask", "permissions.default": "allow" });
		await expect(
			bashTool().execute("critical-deny", { command: "rm -rf /" }, undefined, undefined, {
				settings,
				home: tempDir,
			} as AgentToolContext),
		).rejects.toThrow(/Critical pattern detected|blocked/i);
	});

	it("evaluates the gate once when no handler revised the input", async () => {
		// The short-circuit decision is authoritative when the input is
		// unchanged, so the wrapper must not re-evaluate (rule loads + bash
		// piece analysis per call). A counting approval proves exactly one run.
		let approvalCalls = 0;
		const countedTool = {
			name: "counted",
			description: "counting approval tool",
			approval: () => {
				approvalCalls += 1;
				return "write";
			},
			execute: async () => ({ content: [] }),
		} as unknown as AgentTool;
		const runner = {
			consumeToolCallEmitted: () => false,
			hasHandlers: () => false,
			hasUI: () => false,
		} as unknown as ExtensionRunner;
		const wrapper = new ExtensionToolWrapper(countedTool, runner);
		const settings = approvalSettings({ "tools.approvalMode": "always-ask" });
		await expect(
			wrapper.execute("single-eval", { x: "1" }, undefined, undefined, { settings } as unknown as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
		expect(approvalCalls).toBe(1);
	});

	it("records per-piece bash attribution in the audit log", async () => {
		// A compound denial must carry the piece breakdown plus the denying
		// piece's rule id/layer in the audit (spec §7) — the wrapper records
		// the engine decision threaded out of the bash tool's approval.
		fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: deny-npm\n    tool: bash\n    match: { command: 'npm publish' }\n    action: deny\n    reason: fixture\n",
		);
		const settings = approvalSettings({ "permissions.audit.enabled": true, "permissions.default": "allow" });
		await expect(
			bashTool().execute("audit-compound", { command: "git status && npm publish" }, undefined, undefined, {
				settings,
				sessionManager,
				home: tempDir,
			} as unknown as AgentToolContext),
		).rejects.toThrow(/Denied: piece "npm publish"/);

		const audit = await readAudit(auditFilePath(cwd));
		const record = audit.find(
			candidate => candidate.tool === "bash" && candidate.command === "git status && npm publish",
		);
		expect(record).toBeDefined();
		expect(record?.outcome).toBe("blocked");
		expect(record?.pieces).toHaveLength(2);
		// Piece attribution: the denying piece carries its rule id/layer; the
		// allowed piece reflects the session's own posture (prompt default).
		expect(record?.pieces?.[0]).toMatchObject({ text: "git status", policy: "prompt" });
		expect(record?.pieces?.[1]).toMatchObject({
			text: "npm publish",
			policy: "deny",
			ruleId: "deny-npm",
			layer: "project",
		});
		expect(record?.ruleId).toBe("deny-npm");
		expect(record?.layer).toBe("project");
	});

	it("rule-denied bash calls carry the allow suggestion keyed to the denied piece", async () => {
		// An exact deny matches the piece but NOT the whole compound command, so
		// a dead-end suggestion proves the wrapper passed the denied PIECE text
		// to renderAllowSuggestion — whole-command text would find no deny and
		// fall back to the posture first-candidate suggestion instead.
		fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".omp", "permissions.yml"),
			"rules:\n  - id: deny-push-exact\n    tool: bash\n    match: { command: 'git push origin main' }\n    action: deny\n",
		);
		const settings = approvalSettings({});
		let message = "";
		try {
			await bashTool().execute("deny-suggest-piece", { command: "git push origin main && echo hi" }, undefined, undefined, {
				settings,
				sessionManager,
				home: tempDir,
			} as unknown as AgentToolContext);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/Denied: piece "git push origin main"/);
		expect(message).toMatch(/no allow rule can override the matching deny/);
		expect(message).not.toContain("To allow this call, add rule:");
	});

	it("curated hard-denies stay suggestion-free", async () => {
		// rm -rf / carries no ruleId, so the bash suggestion gate stays closed:
		// the error names the curated deny and nothing more.
		const settings = approvalSettings({});
		let message = "";
		try {
			await bashTool().execute("curated-deny", { command: "rm -rf /" }, undefined, undefined, {
				settings,
				home: tempDir,
			} as AgentToolContext);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/blocked/i);
		expect(message).not.toContain("To allow this call, add rule:");
		expect(message).not.toContain("no allow rule can override");
	});
});
