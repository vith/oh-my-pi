import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger } from "@oh-my-pi/pi-utils";
import * as audit from "../../../src/tools/permissions/audit";
import { type AuditRecord, appendAudit, auditFilePath, readAudit } from "../../../src/tools/permissions/audit";

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

describe("permission audit log (JSONL, rotating)", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-audit-"));
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("appends JSONL under <cwd>/.omp and readAudit returns newest-first with every field intact", async () => {
		const file = auditFilePath(tempDir);
		const rich: AuditRecord = {
			ts: 123456,
			sessionId: "session-1",
			agent: "codex",
			tool: "bash",
			command: "rm -rf /",
			args: { command: "rm -rf /" },
			decision: "deny",
			ruleId: "curated-1",
			layer: "curated",
			reason: "matches curated critical pattern /rm -rf/",
			pieces: [{ text: "rm -rf /", policy: "deny" }],
			outcome: "blocked",
		};
		await appendAudit(file, rich);
		await appendAudit(file, {
			ts: 999,
			tool: "bash",
			decision: "allow",
			outcome: "executed",
			args: { command: "echo ok" },
		});

		const records = await readAudit(file);
		expect(records).toHaveLength(2);
		// Newest first.
		expect(records[0]).toEqual({
			ts: 999,
			tool: "bash",
			decision: "allow",
			outcome: "executed",
			args: { command: "echo ok" },
		});
		expect(records[1]).toEqual(rich);
		// On-disk shape is one JSON object per line.
		const raw = (await Bun.file(file).text()).trim().split("\n");
		expect(raw).toHaveLength(2);
		expect(JSON.parse(raw[0])).toEqual(records[1]);
	});

	it("rotates to the newest maxEntries records once the file exceeds maxEntries", async () => {
		const file = path.join(tempDir, "rot.jsonl");
		for (let i = 0; i < 7; i++) {
			await appendAudit(file, { ts: i, tool: "bash", decision: "allow" }, 3);
		}
		const records = await readAudit(file);
		expect(records.map(r => r.ts)).toEqual([6, 5, 4]);
		const raw = (await Bun.file(file).text()).trim().split("\n");
		expect(raw).toHaveLength(3);
	});

	it("keeps rotating as more records arrive after the first rotation", async () => {
		const file = path.join(tempDir, "rot2.jsonl");
		for (let i = 0; i < 12; i++) {
			await appendAudit(file, { ts: i, tool: "bash", decision: "allow" }, 4);
		}
		const records = await readAudit(file);
		expect(records.map(r => r.ts)).toEqual([11, 10, 9, 8]);
	});

	it("readAudit returns [] for a missing file", async () => {
		await expect(readAudit(path.join(tempDir, "missing.jsonl"))).resolves.toEqual([]);
	});

	it("readAudit skips malformed lines instead of failing", async () => {
		const file = path.join(tempDir, "dirty.jsonl");
		await appendAudit(file, { ts: 1, tool: "a", decision: "allow" });
		await fs.appendFile(file, "{not json}\n", "utf8");
		await appendAudit(file, { ts: 2, tool: "b", decision: "deny" });
		const records = await readAudit(file);
		expect(records.map(r => r.ts)).toEqual([2, 1]);
	});

	it("readAudit honors a limit", async () => {
		const file = path.join(tempDir, "limit.jsonl");
		for (let i = 0; i < 5; i++) {
			await appendAudit(file, { ts: i, tool: "bash", decision: "allow" });
		}
		const records = await readAudit(file, 2);
		expect(records.map(r => r.ts)).toEqual([4, 3]);
	});
});

describe("wrapper records permission decisions into the audit log", () => {
	let tempDir: string;
	let cwd: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let auditFile: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-audit-gate-"));
		cwd = path.join(tempDir, "cwd");
		await fs.mkdir(cwd, { recursive: true });
		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		auditFile = auditFilePath(cwd);
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			// Audit is exercised explicitly per call via the context settings; keep the
			// session's own settings audit-free so nothing leaks from incidental calls.
			settings: Settings.isolated({ "permissions.audit.enabled": false }),
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
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function bashTool() {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		return bash;
	}

	function ctx(settings: Settings): AgentToolContext {
		return { settings, sessionManager, home: tempDir } as unknown as AgentToolContext;
	}

	it("records an allowed call after execution with outcome executed", async () => {
		const settings = Settings.isolated({ "permissions.default": "allow" });
		const result = await bashTool().execute(
			"audit-allow",
			{ command: "echo audit-ok" },
			undefined,
			undefined,
			ctx(settings),
		);
		expect(textOf(result)).toContain("audit-ok");

		const records = await readAudit(auditFile);
		const record = records[0];
		expect(record.tool).toBe("bash");
		expect(record.command).toBe("echo audit-ok");
		expect(record.args).toEqual({ command: "echo audit-ok" });
		expect(record.decision).toBe("allow");
		expect(record.outcome).toBe("executed");
		expect(record.sessionId).toBe(sessionManager.getSessionId());
		expect(record.ts).toBeGreaterThan(0);
	});

	it("records a gate-time deny as blocked before execute", async () => {
		const settings = Settings.isolated({ "permissions.default": "deny" });
		await expect(
			bashTool().execute("audit-deny", { command: "echo never" }, undefined, undefined, ctx(settings)),
		).rejects.toThrow(/blocked/);

		const records = await readAudit(auditFile);
		const record = records[0];
		expect(record.tool).toBe("bash");
		expect(record.command).toBe("echo never");
		expect(record.decision).toBe("deny");
		expect(record.outcome).toBe("blocked");
		expect(record.sessionId).toBe(sessionManager.getSessionId());
	});

	it("records a legacy bash.patterns deny with rule metadata (layer, ruleId)", async () => {
		const settings = Settings.isolated({
			"permissions.default": "allow",
			"bash.patterns": [{ match: "echo audit-legacy", approval: "deny" }],
		});
		await expect(
			bashTool().execute("audit-legacy-deny", { command: "echo audit-legacy" }, undefined, undefined, ctx(settings)),
		).rejects.toThrow(/blocked/);

		const records = await readAudit(auditFile);
		const record = records[0];
		expect(record.tool).toBe("bash");
		expect(record.command).toBe("echo audit-legacy");
		expect(record.decision).toBe("deny");
		expect(record.outcome).toBe("blocked");
		expect(record.layer).toBe("legacy");
		expect(record.ruleId).toBe("legacy-0");
	});

	it("records a curated critical deny with its reason", async () => {
		const settings = Settings.isolated({ "permissions.default": "allow" });
		await expect(
			bashTool().execute("audit-critical", { command: "rm -rf /" }, undefined, undefined, ctx(settings)),
		).rejects.toThrow(/blocked/i);

		const records = await readAudit(auditFile);
		const record = records[0];
		expect(record.tool).toBe("bash");
		expect(record.decision).toBe("deny");
		expect(record.outcome).toBe("blocked");
		expect(record.reason).toMatch(/matches curated critical pattern/);
	});

	it("keeps the tool call working when the audit append fails, warning once", async () => {
		const appendSpy = vi.spyOn(audit, "appendAudit").mockRejectedValue(new Error("disk full"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const settings = Settings.isolated({ "permissions.default": "allow" });
			const result = await bashTool().execute(
				"audit-silent",
				{ command: "echo silent-ok" },
				undefined,
				undefined,
				ctx(settings),
			);
			expect(textOf(result)).toContain("silent-ok");
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/audit/i);
		} finally {
			appendSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("does not record when permissions.audit.enabled is false", async () => {
		const before = await readAudit(auditFile);
		const settings = Settings.isolated({ "permissions.default": "allow", "permissions.audit.enabled": false });
		const result = await bashTool().execute(
			"audit-disabled",
			{ command: "echo hidden" },
			undefined,
			undefined,
			ctx(settings),
		);
		expect(textOf(result)).toContain("hidden");
		const after = await readAudit(auditFile);
		expect(after).toHaveLength(before.length);
	});
});
