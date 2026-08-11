import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-permission-gate-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
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
			} as AgentToolContext),
		).rejects.toThrow(/requires approval but no interactive UI available/);
	});

	it("engine posture allow lets unruled calls through even with always-ask mode", async () => {
		// Pre-engine: always-ask prompts (no UI) and this rejects. Post-engine:
		// the explicitly configured permissions.default: allow posture wins.
		const settings = approvalSettings({ "tools.approvalMode": "always-ask", "permissions.default": "allow" });
		const result = await bashTool().execute("posture-allow", { command: "echo ok" }, undefined, undefined, {
			settings,
		} as AgentToolContext);
		expect(textOf(result)).toContain("ok");
	});

	it("legacy yolo mode still maps to allow posture", async () => {
		const settings = approvalSettings({ "tools.approvalMode": "yolo" });
		const result = await bashTool().execute("yolo-legacy", { command: "echo ok" }, undefined, undefined, {
			settings,
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
			} as AgentToolContext),
		).rejects.toThrow(/Critical pattern detected|blocked/i);
	});
});
