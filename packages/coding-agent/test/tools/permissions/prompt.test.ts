import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	EngineContext,
	EngineDecision,
	PieceEvaluation,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	buildCandidates,
	promptForDecision,
	renderAllowSuggestion,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/prompt";
import { normalizeRule, ruleFiles } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const tempHomes: string[] = [];
afterEach(() => {
	for (const dir of tempHomes.splice(0)) {
		removeSyncWithRetries(dir);
	}
});

function tempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-prompt-${Snowflake.next()}-`));
	tempHomes.push(dir);
	return dir;
}

function fakeDecision(overrides: Partial<EngineDecision> = {}): EngineDecision {
	return {
		policy: "prompt",
		tier: "exec",
		source: "posture",
		override: false,
		...overrides,
	};
}

function fakeCtx(home: string): EngineContext {
	return {
		settings: {
			get: () => undefined,
			isConfigured: () => false,
		} as unknown as EngineContext["settings"],
		cwd: path.join(home, "proj"),
		home,
	};
}

function noopUi(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: async () => {},
	} as unknown as ExtensionUIContext;
}

/** Fake UI whose `select` returns labels from a queue, recording every call. */
function queuedSelectUi(labels: string[], calls: string[][] = []) {
	const ui = {
		...noopUi(),
		select: async (_title: string, options: readonly string[]) => {
			calls.push([...options]);
			return labels.length > 0 ? labels.shift() : undefined;
		},
	} as unknown as ExtensionUIContext;
	return { ui, calls };
}

function pendingPiece(text: string): PieceEvaluation {
	return { text, policy: "prompt" };
}

describe("buildCandidates", () => {
	it("bash: exact, first-token pattern, tool-wide", () => {
		const c = buildCandidates("bash", { command: "git status -s" });
		const labels = c.map(x => x.label);
		expect(labels).toContain("Exact: git status -s");
		expect(labels).toContain("Pattern: git *");
		expect(labels).toContain("Tool: bash always");
	});

	it("file tools: exact path and parent glob", () => {
		const c = buildCandidates("write", { path: "src/foo/bar.ts" });
		expect(c.some(x => x.label.includes("src/foo/bar.ts"))).toBe(true);
		expect(c.some(x => x.label.includes("src/foo/**"))).toBe(true);
		expect(c.some(x => x.label.includes("Tool: write always"))).toBe(true);
	});

	it("renders YAML previews normalizeRule accepts (round-trip)", () => {
		const all = [
			...buildCandidates("bash", { command: "npm test" }),
			...buildCandidates("write", { path: "src/x.ts" }),
			...buildCandidates("ask", { question: "hi" }),
		];
		expect(all.length).toBeGreaterThan(0);
		for (const cand of all) {
			const parsed = YAML.parse(cand.yaml);
			const rule = normalizeRule(parsed, "dynamic");
			expect(rule).not.toBeNull();
			expect(rule?.action).toBe(cand.rule.action);
		}
	});

	it("includes deny candidates with the same scopes when a piece is pending", () => {
		const c = buildCandidates("bash", { command: "git push" }, [pendingPiece("git push")]);
		const denies = c.filter(x => x.rule.action === "deny");
		expect(denies.length).toBeGreaterThan(0);
		expect(denies.some(x => x.rule.match.command === "git push")).toBe(true);
		expect(denies.some(x => x.rule.match.command === "git *")).toBe(true);
		expect(denies.some(x => x.rule.match.arg === "*")).toBe(true);
	});

	it("offers no deny candidates when every piece is hard-denied", () => {
		const c = buildCandidates("bash", { command: "rm -rf /" }, [{ text: "rm -rf /", policy: "deny" }]);
		expect(c.length).toBeGreaterThan(0);
		expect(c.every(x => x.rule.action === "allow")).toBe(true);
	});

	it("candidate ids are distinct across scopes", () => {
		// Exact {command:"git"} and pattern {command:"git *"} slug identically;
		// they must never share an id or re-remembering would replace the other.
		const c = buildCandidates("bash", { command: "git" });
		const ids = new Set(c.map(x => x.rule.id));
		expect(ids.size).toBe(c.length);
		const singleToken = buildCandidates("write", { path: "./**" });
		expect(new Set(singleToken.map(x => x.rule.id)).size).toBe(singleToken.length);
	});
});

describe("promptForDecision", () => {
	it("denies when the user cancels (undefined select)", async () => {
		const home = tempHome();
		const res = await promptForDecision(noopUi(), "bash", { command: "x" }, fakeDecision(), fakeCtx(home));
		expect(res.policy).toBe("deny");
	});

	it("prompts per pending piece in command order and allows", async () => {
		const { ui, calls } = queuedSelectUi(["Allow once", "Allow once"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(calls).toHaveLength(2);
		for (const options of calls) {
			expect(options).toEqual(["Allow once", "Allow & remember…", "Deny", "Deny & remember…"]);
		}
	});

	it("skips already-allowed pieces", async () => {
		const { ui, calls } = queuedSelectUi(["Allow once"]);
		const decision = fakeDecision({
			pieces: [{ text: "echo a", policy: "allow" }, pendingPiece("echo b")],
		});
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(calls).toHaveLength(1);
	});

	it("stops prompting after a deny", async () => {
		const { ui, calls } = queuedSelectUi(["Deny"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("deny");
		expect(calls).toHaveLength(1);
	});

	it("writes a dynamic rule when a candidate is remembered", async () => {
		const home = tempHome();
		const { ui } = queuedSelectUi(["Allow & remember…", "Exact: git status -s"]);
		const decision = fakeDecision({ pieces: [pendingPiece("git status -s")] });
		const res = await promptForDecision(ui, "bash", { command: "git status -s" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(res.remembered?.match).toEqual({ command: "git status -s" });

		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const written = doc.rules.find(r => (r.match as Record<string, unknown>).command === "git status -s");
		expect(written).toBeDefined();
		expect(written?.tool).toBe("bash");
		expect(written?.action).toBe("allow");
	});

	it("writes a deny rule when deny & remember is chosen", async () => {
		const home = tempHome();
		const { ui } = queuedSelectUi(["Deny & remember…", "Deny exact: git status -s"]);
		const decision = fakeDecision({ pieces: [pendingPiece("git status -s")] });
		const res = await promptForDecision(ui, "bash", { command: "git status -s" }, decision, fakeCtx(home));
		expect(res.policy).toBe("deny");

		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const written = doc.rules.find(r => (r.match as Record<string, unknown>).command === "git status -s");
		expect(written).toBeDefined();
		expect(written?.action).toBe("deny");
	});

	it("remembering exact then pattern for a single-token command keeps both rules", async () => {
		const home = tempHome();
		const { ui } = queuedSelectUi(["Allow & remember…", "Exact: git", "Allow & remember…", "Pattern: git *"]);
		const decision = fakeDecision({ pieces: [pendingPiece("git")] });
		const ctx = fakeCtx(home);
		const first = await promptForDecision(ui, "bash", { command: "git" }, decision, ctx);
		expect(first.policy).toBe("allow");
		const second = await promptForDecision(ui, "bash", { command: "git" }, decision, ctx);
		expect(second.policy).toBe("allow");

		const file = ruleFiles(ctx.cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const commands = doc.rules.map(r => (r.match as Record<string, unknown>).command);
		expect(commands).toContain("git");
		expect(commands).toContain("git *");
		const ids = doc.rules.map(r => r.id as string);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("PTY calls prompt once for the whole command, not per piece", async () => {
		const { ui, calls } = queuedSelectUi(["Allow once"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(
			ui,
			"bash",
			{ command: "echo a && echo b", pty: true },
			decision,
			fakeCtx(tempHome()),
		);
		expect(res.policy).toBe("allow");
		expect(calls).toHaveLength(1);
	});

	it("PTY remember candidates are scoped to the whole command text", async () => {
		const home = tempHome();
		const { ui } = queuedSelectUi(["Allow & remember…", "Exact: echo a && echo b"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(
			ui,
			"bash",
			{ command: "echo a && echo b", pty: true },
			decision,
			fakeCtx(home),
		);
		expect(res.policy).toBe("allow");

		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const written = doc.rules.find(r => (r.match as Record<string, unknown>).command === "echo a && echo b");
		expect(written).toBeDefined();
		expect(written?.action).toBe("allow");
	});

	it("forced prompts (provider safety checks) offer only Approve/Deny", async () => {
		const { ui, calls } = queuedSelectUi(["Approve"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a" }, decision, fakeCtx(tempHome()), {
			includeCandidates: false,
		});
		expect(res.policy).toBe("allow");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["Approve", "Deny"]);
	});

	it("uses the dialog when the UI exposes showPermissionDialog", async () => {
		const home = tempHome();
		let dialogCalls = 0;
		const ui = {
			...noopUi(),
			showPermissionDialog: async () => {
				dialogCalls += 1;
				return 0; // "Allow once"
			},
		} as unknown as ExtensionUIContext;
		const decision = fakeDecision({ pieces: [pendingPiece("echo a")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(dialogCalls).toBe(1);
	});
});

describe("renderAllowSuggestion", () => {
	it("renders the exact allow-rule YAML after the instruction line", () => {
		const text = renderAllowSuggestion("bash", { command: "git push" });
		expect(text).toContain("To allow this call, add rule:");
		const yaml = text.slice(
			text.indexOf("To allow this call, add rule:\n") + "To allow this call, add rule:\n".length,
		);
		const rule = normalizeRule(YAML.parse(yaml), "dynamic");
		expect(rule).not.toBeNull();
		expect(rule!.tool).toBe("bash");
		expect(rule!.action).toBe("allow");
		expect((rule!.match as Record<string, unknown>).command).toBe("git push");
	});
});
