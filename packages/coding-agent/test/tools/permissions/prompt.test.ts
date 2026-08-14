import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionUIContext, PermissionDialogRequest } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	EngineContext,
	EngineDecision,
	PieceEvaluation,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import { evaluateBashCommand } from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import {
	buildCandidates,
	buildDialogLines,
	promptForDecision,
	rememberCompound,
	renderAllowSuggestion,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/prompt";
import { normalizeRule, ruleFiles } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import type { Suggestion } from "@oh-my-pi/pi-coding-agent/tools/permissions/suggest";
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

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
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

/** Fake UI whose `showPermissionDialog` returns scripted indices, recording every request. */
function queuedDialogUi(indices: Array<number | undefined>, requests: PermissionDialogRequest[] = []) {
	const ui = {
		...noopUi(),
		showPermissionDialog: async (request: PermissionDialogRequest) => {
			requests.push(request);
			return indices.length > 0 ? indices.shift() : undefined;
		},
	} as unknown as ExtensionUIContext;
	return { ui, requests };
}

/** A temp-home rule allowing `echo *`, so `git log -n 5 && echo hi` resolves to 1 of 2 pieces pending. */
function compoundFixture() {
	const home = tempHome();
	write(
		path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
		"rules:\n  - id: echo-all\n    tool: bash\n    match: { command: 'echo *' }\n    action: allow\n",
	);
	return { home, ctx: fakeCtx(home), decision: evaluateBashCommand("git log -n 5 && echo hi", fakeCtx(home)) };
}

/** The v3 compound actions, in dialog order. */
const COMPOUND_ACTIONS = [
	"Allow all pending once",
	"Allow all & remember…",
	"Deny all pending",
	"Decide per piece →",
] as const;

describe("buildCandidates", () => {
	it("bash: exact and first-token pattern, never tool-wide (spec §5.1)", () => {
		// bash can execute anything, so a tool-wide allow is the yolo knob and
		// the dialog never offers it (hand-editable in the file only).
		const c = buildCandidates("bash", { command: "git status -s" });
		const labels = c.map(x => x.label);
		expect(labels).toContain("Exact: git status -s");
		expect(labels).toContain("Pattern: git status *");
		expect(labels).not.toContain("Tool: bash always");
		expect(c.some(x => x.rule.match.arg === "*")).toBe(false);
	});

	it("offers no remember candidates for unanalyzable shell-control bash commands", () => {
		// Allow rules on redirect/-c-reinterpreting commands degrade to a
		// prompt (engine ruling R1) and whole-command matches never see
		// per-piece evaluation, so exact/pattern/tool remember rules can never
		// suppress the prompt. Analyzable pipelines/substitutions keep their
		// candidates — a remembered rule can suppress them once every
		// sub-command passes the filter.
		for (const command of [
			"git log > out",
			"python3 -c'x'", // concatenated -c form (guard-true on its own)
			"python3 -c 'print(1)'", // space-separated -c with shell chars in the quoted arg
		]) {
			expect(buildCandidates("bash", { command })).toEqual([]);
			expect(buildCandidates("bash", { command }, [pendingPiece(command)])).toEqual([]);
		}
		// Control: the same scopes stay for a shell-control-free command.
		const control = buildCandidates("bash", { command: "git status -s" });
		expect(control.some(candidate => candidate.rule.match.command === "git status -s")).toBe(true);
		expect(control.some(candidate => candidate.rule.match.command === "git status *")).toBe(true);
		expect(control.some(candidate => candidate.rule.match.arg === "*")).toBe(false); // no tool-wide for bash
		// A pipeline is analyzable: its candidates come back too.
		const piped = buildCandidates("bash", { command: "git log | head -5" });
		expect(piped.some(candidate => candidate.rule.match.command === "git log | head -5")).toBe(true);
		expect(piped.some(candidate => candidate.rule.match.command === "git log *")).toBe(true);
	});

	it("file tools: exact path and parent glob, no tool-wide for write tools", () => {
		const c = buildCandidates("write", { path: "src/foo/bar.ts" });
		expect(c.some(x => x.label.includes("src/foo/bar.ts"))).toBe(true);
		expect(c.some(x => x.label.includes("src/foo/**"))).toBe(true);
		// write is exec-capable, so no tool-wide offer (spec §5.1)
		expect(c.some(x => x.label.includes("Tool: write always"))).toBe(false);
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
		expect(denies.some(x => x.rule.match.command === "git push *")).toBe(true);
		expect(denies.some(x => x.rule.match.arg === "*")).toBe(false); // no tool-wide deny for bash
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

	it("subcommand-verb commands pattern on the subcommand, not the bare first token", () => {
		// A bare `git *` would cover git push/rm/reset/clean; the remember
		// pattern must take the subcommand verb (`git push *`).
		const c = buildCandidates("bash", { command: "git push origin main" });
		expect(c.some(candidate => candidate.rule.match.command === "git push *")).toBe(true);
		expect(c.some(candidate => candidate.rule.match.command === "git *")).toBe(false);
	});

	it("non-subcommand first tokens keep the bare first-token pattern", () => {
		const c = buildCandidates("bash", { command: "echo hello world" });
		expect(c.some(candidate => candidate.rule.match.command === "echo *")).toBe(true);
		// A bare single token (no subcommand available) still patterns on it.
		const bare = buildCandidates("bash", { command: "git" });
		expect(bare.some(candidate => candidate.rule.match.command === "git *")).toBe(true);
	});
});

describe("rememberCompound", () => {
	// Distinct first tokens so the two globs differ (git log → "git log *", echo → "echo *").
	const twoPieces = [pendingPiece("git log -n 5"), pendingPiece("echo hi")];

	function dialogUi(
		requests: PermissionDialogRequest[],
		onRequest: (request: PermissionDialogRequest) => number | undefined,
	) {
		return {
			...noopUi(),
			showPermissionDialog: async (request: PermissionDialogRequest) => {
				requests.push(request);
				return onRequest(request);
			},
		} as unknown as ExtensionUIContext;
	}

	async function writtenCommands(ctx: EngineContext): Promise<Array<Record<string, unknown>>> {
		const file = ruleFiles(ctx.cwd, ctx.home).dynamic;
		if (!fs.existsSync(file)) return [];
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		return doc.rules.map(rule => rule.match as Record<string, unknown>);
	}

	it("builds first-token globs, preselects the write option, writes the checked rules", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const requests: PermissionDialogRequest[] = [];
		const ui = dialogUi(requests, request => {
			expect(request.checklist).toBe(true);
			expect(request.allowEdit).toBe(true);
			expect(request.initialIndex).toBe(2); // write button preselected — Enter writes (spec §5.1)
			expect(request.previewFor).toBeDefined();
			expect(request.options).toHaveLength(3);
			expect(request.options[0]).toEqual({
				label: "git log *",
				description: "git log -n 5",
				checked: true,
				toggleable: true,
			});
			expect(request.options[1]).toEqual({
				label: "echo *",
				description: "echo hi",
				checked: true,
				toggleable: true,
			});
			const write = request.options[2];
			expect(write?.label).toBe("Write checked allow rules (2)");
			expect(write?.labelFor?.([true, true, false])).toBe("Write checked allow rules (2)");
			expect(write?.labelFor?.([true, false, false])).toBe("Write checked allow rules (1)");
			// preview renders the YAML of the checked rows only
			const preview = request.previewFor?.([true, false, false]);
			expect(preview).toContain("git log *");
			expect(preview).not.toContain("echo *");
			return 2; // the write button
		});
		const remembered = await rememberCompound(ui, twoPieces, "allow", ctx);
		expect(remembered).toBeDefined();
		expect(remembered?.match).toEqual({ command: "git log *" }); // first written rule
		expect(requests).toHaveLength(1);
		const commands = (await writtenCommands(ctx)).map(match => match.command).sort();
		expect(commands).toEqual(["echo *", "git log *"]);
	});

	it("skips unchecked rows read back from the dialog (component write-back)", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const ui = dialogUi([], request => {
			// simulate the component's space-toggle write-back (Task 4 Step 4):
			// the user unchecks the first row, then presses Enter on the write
			// button.
			request.options[0]!.checked = false;
			return 2;
		});
		const remembered = await rememberCompound(ui, twoPieces, "allow", ctx);
		expect(remembered).toBeDefined();
		expect(remembered?.match).toEqual({ command: "echo *" });
		expect((await writtenCommands(ctx)).map(match => match.command)).toEqual(["echo *"]);
	});

	it("returns undefined and writes nothing when every row is unchecked", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const ui = dialogUi([], request => {
			request.options[0]!.checked = false;
			request.options[1]!.checked = false;
			return 2;
		});
		const remembered = await rememberCompound(ui, twoPieces, "allow", ctx);
		expect(remembered).toBeUndefined();
		expect(await writtenCommands(ctx)).toEqual([]);
	});

	it("e sentinel (-2) edits the row-0 glob via ui.input and writes it", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		let inputTitle = "";
		const ui = {
			...noopUi(),
			showPermissionDialog: async () => -2, // e on checklist row 0
			input: async (title: string) => {
				inputTitle = title;
				return "git log -5 *";
			},
		} as unknown as ExtensionUIContext;
		const remembered = await rememberCompound(ui, twoPieces, "allow", ctx);
		expect(remembered).toBeDefined();
		expect(remembered?.match).toEqual({ command: "git log -5 *" });
		expect(inputTitle).toContain("git log -n 5");
		expect((await writtenCommands(ctx)).map(match => match.command)).toEqual(["git log -5 *"]);
	});

	it("plain cancel (-1) writes nothing", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const { ui } = queuedDialogUi([-1]);
		const remembered = await rememberCompound(ui, twoPieces, "allow", ctx);
		expect(remembered).toBeUndefined();
		expect(await writtenCommands(ctx)).toEqual([]);
	});

	it("subcommand-verb pieces pattern on the subcommand (git push → git push *)", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const requests: PermissionDialogRequest[] = [];
		const ui = dialogUi(requests, request => {
			expect(request.options[0]?.label).toBe("git push *");
			expect(request.options[0]?.description).toBe("git push origin main");
			return 1; // the write button
		});
		const remembered = await rememberCompound(ui, [pendingPiece("git push origin main")], "allow", ctx);
		expect(remembered?.match).toEqual({ command: "git push *" });
	});

	it("two pieces of the same subcommand verb write distinct per-subcommand rules", async () => {
		// `git log *` and `git status *` are different rules; both are written
		// (no id collision, no dedupe that would drop one).
		const home = tempHome();
		const ctx = fakeCtx(home);
		const ui = dialogUi([], () => 2); // the write button
		const remembered = await rememberCompound(
			ui,
			[pendingPiece("git log -n 5"), pendingPiece("git status -s")],
			"allow",
			ctx,
		);
		expect(remembered).toBeDefined();
		const commands = (await writtenCommands(ctx)).map(match => match.command).sort();
		expect(commands).toEqual(["git log *", "git status *"]);
		const file = ruleFiles(ctx.cwd, ctx.home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const ids = doc.rules.map(rule => rule.id as string);
		expect(new Set(ids).size).toBe(2);
	});
});

describe("promptForDecision", () => {
	it("denies when the user cancels (undefined select)", async () => {
		const home = tempHome();
		const res = await promptForDecision(noopUi(), "bash", { command: "x" }, fakeDecision(), fakeCtx(home));
		expect(res.policy).toBe("deny");
	});

	it("prompts once for the whole compound call and allows", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow all pending once
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options.map(option => option.label)).toEqual([...COMPOUND_ACTIONS]);
	});

	it("v3 dialog title asks the question; tool and reason travel in the lines", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow all pending once
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()), {
			approvalReason: "fixture reason",
		});
		expect(res.policy).toBe("allow");
		expect(requests[0]?.title).toBe("Approve this command?");
		const linesJson = JSON.stringify(requests[0]?.lines);
		expect(linesJson).toContain("tool: bash");
		expect(linesJson).toContain("reason: fixture reason");
	});

	it("non-bash v3 dialogs title with the tool call question", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow once
		const decision = fakeDecision({ policy: "prompt", pieces: undefined });
		const res = await promptForDecision(ui, "read", { path: "src/x.ts" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(requests[0]?.title).toBe("Approve read call?");
		expect(JSON.stringify(requests[0]?.lines)).toContain("tool: read");
	});

	it("forced prompts keep the provided legacy title", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Approve
		const decision = fakeDecision({ pieces: [pendingPiece("echo a")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a" }, decision, fakeCtx(tempHome()), {
			includeCandidates: false,
			title: "Allow tool: bash\nReason: safety",
		});
		expect(res.policy).toBe("allow");
		expect(requests[0]?.title).toBe("Allow tool: bash\nReason: safety");
	});

	it("keeps already-allowed pieces visible in the compound dialog", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow all pending once
		const decision = fakeDecision({
			pieces: [{ text: "echo a", policy: "allow" }, pendingPiece("echo b")],
		});
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(1);
		// The allowed piece stays visible with its status in the dialog lines.
		expect(JSON.stringify(requests[0]?.lines)).toContain("echo a");
		expect(JSON.stringify(requests[0]?.lines)).toContain("allowed");
	});

	it("stops after a compound deny-all", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([2], requests); // Deny all pending
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("deny");
		expect(requests).toHaveLength(1);
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
		// A shell-control-free command: PTY calls prompt once for the whole
		// command, so the remember scopes use the whole text (which per-piece
		// evaluation of a single-piece command sees).
		const home = tempHome();
		const { ui } = queuedSelectUi(["Allow & remember…", "Exact: echo a b"]);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a b", pty: true }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");

		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		const written = doc.rules.find(r => (r.match as Record<string, unknown>).command === "echo a b");
		expect(written).toBeDefined();
		expect(written?.action).toBe("allow");
	});

	it("PTY compound commands lose the dead remember options", async () => {
		// A PTY compound is prompted as one unit with the whole command text,
		// but per-piece rule evaluation never sees that text and rule allows
		// degrade under shell control — the remember options are dropped.
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
		expect(calls[0]).toEqual(["Allow once", "Deny"]);
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

	it("drops the remember options with a note for unanalyzable shell-control bash commands", async () => {
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = {
			...noopUi(),
			showPermissionDialog: async (request: PermissionDialogRequest) => {
				captured.request = request;
				return 0; // "Allow once"
			},
		} as unknown as ExtensionUIContext;
		// A redirect cannot be suppressed by a remembered rule (R1); an
		// analyzable pipeline keeps its remember options.
		const decision = fakeDecision({ pieces: [pendingPiece("git status < seed")] });
		const res = await promptForDecision(ui, "bash", { command: "git status < seed" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(captured.request?.options.map(option => option.label)).toEqual(["Allow once", "Deny"]);
		expect(
			captured.request?.lines?.some(
				line => typeof line === "string" && line.includes("Remembered rules cannot suppress"),
			),
		).toBe(true);
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

	it("compound command prompts once with v3 actions", async () => {
		const { ctx, decision } = compoundFixture();
		expect(decision.pieces?.filter(piece => piece.policy === "prompt")).toHaveLength(1);
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow all pending once
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options.map(option => option.label)).toEqual([...COMPOUND_ACTIONS]);
	});

	it("Deny all pending denies the call", async () => {
		const { ctx, decision } = compoundFixture();
		const { ui } = queuedDialogUi([2]); // Deny all pending
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("deny");
	});

	it("drill-down denies when any piece is denied", async () => {
		const ctx = fakeCtx(tempHome());
		const decision = evaluateBashCommand("git log -n 5 && echo hi", ctx);
		expect(decision.pieces?.filter(piece => piece.policy === "prompt")).toHaveLength(2);
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([3, 1, 2], requests); // drill-down → "git log -n 5" → Deny once
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("deny");
		expect(requests).toHaveLength(3);
		expect(requests[0]?.options.map(option => option.label)).toEqual([...COMPOUND_ACTIONS]);
		expect(requests[1]?.title).toBe("Decide per piece");
		expect(requests[1]?.options.map(option => option.label)).toEqual(["Back", "git log -n 5", "echo hi"]);
		expect(requests[2]?.options.map(option => option.label)).toEqual([
			"Allow once",
			"Allow & remember…",
			"Deny",
			"Deny & remember…",
		]);
	});

	it("esc (undefined) on the main dialog denies without a rule", async () => {
		const { ctx, decision } = compoundFixture();
		const { ui } = queuedDialogUi([undefined]);
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("deny");
		expect(res.remembered).toBeUndefined();
		// No rule was written: the fixture's echo rule is the only one left.
		const file = ruleFiles(ctx.cwd, ctx.home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.map(rule => (rule.match as Record<string, unknown>).command)).toEqual(["echo *"]);
	});

	it("PTY calls keep the single-unit flow with the old option set", async () => {
		const { ui, calls } = queuedSelectUi(["Allow once"]);
		// A non-compound PTY command is one prompt unit with the old four
		// options (compound PTY commands drop the remember options — covered
		// separately below).
		const decision = fakeDecision({ pieces: [pendingPiece("echo a b")] });
		const res = await promptForDecision(
			ui,
			"bash",
			{ command: "echo a b", pty: true },
			decision,
			fakeCtx(tempHome()),
		);
		expect(res.policy).toBe("allow");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["Allow once", "Allow & remember…", "Deny", "Deny & remember…"]);
	});

	it("Allow all & remember… writes a first-token glob rule per pending piece", async () => {
		const { ctx, decision } = compoundFixture();
		expect(decision.pieces?.filter(piece => piece.policy === "prompt")).toHaveLength(1);
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([1, 1], requests); // Allow all & remember… → write option
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("allow");
		expect(res.remembered?.match).toEqual({ command: "git log *" });
		expect(requests[0]?.options.map(option => option.label)).toEqual([...COMPOUND_ACTIONS]);
		expect(requests[1]?.checklist).toBe(true);
		expect(requests[1]?.options.map(option => option.label)).toEqual(["git log *", "Write checked allow rules (1)"]);
		const file = ruleFiles(ctx.cwd, ctx.home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.map(rule => (rule.match as Record<string, unknown>).command)).toContain("git log *");
	});

	it("single-piece scope: Pattern is preselected, Custom… is offered, bash has no Tool always", async () => {
		const home = tempHome();
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([1, 1], requests); // Allow & remember… → Pattern (preselected)
		const decision = fakeDecision({ pieces: [pendingPiece("git branch -a")] });
		const res = await promptForDecision(ui, "bash", { command: "git branch -a" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(res.remembered?.match).toEqual({ command: "git branch *" }); // first-token glob
		expect(requests).toHaveLength(2);
		const scope = requests[1]!;
		expect(scope.initialIndex).toBe(1); // Pattern preselected
		const labels = scope.options.map(option => option.label);
		expect(labels).toEqual(["Exact: git branch -a", "Pattern: git branch *", "Custom…"]);
		expect(labels).not.toContain("Tool: bash always");
		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.map(rule => (rule.match as Record<string, unknown>).command)).toEqual(["git branch *"]);
	});

	it("Custom… edits the glob via ui.input and writes the edited pattern", async () => {
		const home = tempHome();
		let placeholder = "";
		let dialogCalls = 0;
		const ui = {
			...noopUi(),
			showPermissionDialog: async () => {
				dialogCalls += 1;
				return dialogCalls === 1 ? 1 : 2; // Allow & remember… → Custom…
			},
			input: async (_title: string, current?: string) => {
				placeholder = current ?? "";
				return "git branch -a *";
			},
		} as unknown as ExtensionUIContext;
		const decision = fakeDecision({ pieces: [pendingPiece("git branch -a")] });
		const res = await promptForDecision(ui, "bash", { command: "git branch -a" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(res.remembered?.match).toEqual({ command: "git branch -a *" });
		// the placeholder is the recommended first-token glob (spec §5.1:
		// "narrower or wider than the first-token pattern")
		expect(placeholder).toBe("git branch *");
		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.map(rule => (rule.match as Record<string, unknown>).command)).toEqual(["git branch -a *"]);
	});

	it("Tool always is offered for read-only tools", async () => {
		const home = tempHome();
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([1, 0], requests); // Allow & remember… → Exact call
		const decision = fakeDecision({ policy: "prompt", pieces: undefined });
		const res = await promptForDecision(ui, "read", { path: "src/x.ts" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(2);
		const labels = requests[1]!.options.map(option => option.label);
		expect(labels).toContain("Tool: read always"); // read is in CURATED_ALLOW_TOOLS
	});

	it("picking the last scope option (Tool always) for a read-only tool writes the tool rule", async () => {
		// The dialog options include the inserted Custom… row, so the last
		// option is NOT candidates[last]: picking it must still resolve to the
		// tool-wide candidate (regression: label lookup, not raw index).
		const home = tempHome();
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([1, 3], requests); // Allow & remember… → last option (Tool: read always)
		const decision = fakeDecision({ policy: "prompt", pieces: undefined });
		const res = await promptForDecision(ui, "read", { path: "src/x.ts" }, decision, fakeCtx(home));
		expect(res.policy).toBe("allow");
		expect(res.remembered?.tool).toBe("read");
		expect(res.remembered?.match).toEqual({ arg: "*" });
		const labels = requests[1]!.options.map(option => option.label);
		expect(labels[3]).toBe("Tool: read always"); // [Exact, Pattern, Custom…, Tool always]
		const file = ruleFiles(fakeCtx(home).cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.some(rule => rule.tool === "read" && (rule.match as Record<string, unknown>).arg === "*")).toBe(
			true,
		);
	});

	it("drill-down Back with pieces left undecided denies the call", async () => {
		const ctx = fakeCtx(tempHome());
		const decision = evaluateBashCommand("git log -n 5 && echo hi", ctx);
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([3, 0], requests); // drill-down → Back (index 0)
		const res = await promptForDecision(ui, "bash", { command: "git log -n 5 && echo hi" }, decision, ctx);
		expect(res.policy).toBe("deny");
		expect(res.remembered).toBeUndefined();
		expect(requests).toHaveLength(2);
		expect(requests[1]?.title).toBe("Decide per piece");
	});

	it("Deny & remember… on a piece denies the whole call and still writes the rule", async () => {
		const home = tempHome();
		const ctx = fakeCtx(home);
		const decision = fakeDecision({ pieces: [pendingPiece("git status -s"), pendingPiece("echo hi")] });
		// Compound (3 = drill-down) → piece selector (1 = "git status -s";
		// 0 = Back) → per-piece dialog (3 = "Deny & remember…") → deny
		// candidate scope (0 = "Deny exact: git status -s").
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([3, 1, 3, 0], requests);
		const res = await promptForDecision(ui, "bash", { command: "git status -s && echo hi" }, decision, ctx);
		expect(res.policy).toBe("deny");
		expect(res.remembered?.match).toEqual({ command: "git status -s" });
		expect(res.remembered?.action).toBe("deny");
		expect(requests).toHaveLength(4);
		expect(requests[3]?.options.map(option => option.label)).toContain("Deny exact: git status -s");
		const file = ruleFiles(ctx.cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.some(rule => (rule.match as Record<string, unknown>).command === "git status -s")).toBe(true);
	});

	it("forced prompts with multiple pieces stay a single-unit binary dialog", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Approve
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()), {
			includeCandidates: false,
		});
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options.map(option => option.label)).toEqual(["Approve", "Deny"]);
		expect(requests[0]?.suggestions).toBeUndefined();
	});

	it("all pieces already decided allow without a dialog", async () => {
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests);
		const decision = fakeDecision({
			pieces: [
				{ text: "echo a", policy: "allow" },
				{ text: "echo b", policy: "allow" },
			],
		});
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(0);
	});

	it("non-bash tools without pieces still show the dialog", async () => {
		// Non-bash decisions carry no pieces; the zero-pending early return
		// must not swallow them (provider-safety gates and parked approvals
		// rely on the dialog appearing).
		const requests: PermissionDialogRequest[] = [];
		const { ui } = queuedDialogUi([0], requests); // Allow once
		const decision = fakeDecision({ policy: "prompt", pieces: undefined });
		const res = await promptForDecision(ui, "write", { path: "src/x.ts" }, decision, fakeCtx(tempHome()));
		expect(res.policy).toBe("allow");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.options.map(option => option.label)).toEqual([
			"Allow once",
			"Allow & remember…",
			"Deny",
			"Deny & remember…",
		]);
	});
});

describe("promptForDecision with a suggestionsProvider", () => {
	const allowSuggestion: Suggestion = {
		rule: { id: "s-allow", tool: "bash", match: { command: "git status -s" }, action: "allow", reason: "read-only" },
		rationale: "read-only",
	};
	const denySuggestion: Suggestion = {
		rule: { id: "s-deny", tool: "bash", match: { command: "git push" }, action: "deny", reason: "risky" },
		rationale: "risky",
	};

	function capturingDialogUi(captured: { request?: PermissionDialogRequest }, pickIndex: number | undefined) {
		return {
			...noopUi(),
			showPermissionDialog: async (request: PermissionDialogRequest) => {
				captured.request = request;
				return pickIndex;
			},
		} as unknown as ExtensionUIContext;
	}

	it("fires the provider once with the whole call text for compound commands", async () => {
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = capturingDialogUi(captured, 0); // "Allow all pending once"
		const firedPieces: string[] = [];
		const provider = async (piece: string): Promise<Suggestion[]> => {
			firedPieces.push(piece);
			return [allowSuggestion];
		};
		const decision = fakeDecision({ pieces: [pendingPiece("echo a"), pendingPiece("echo b")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a && echo b" }, decision, fakeCtx(tempHome()), {
			suggestionsProvider: provider,
		});
		expect(res.policy).toBe("allow");
		expect(firedPieces).toEqual(["echo a && echo b"]);
		expect(captured.request?.suggestions).toBeDefined();
		const options = await captured.request!.suggestions!;
		expect(options).toHaveLength(1);
		expect(options[0]?.label).toContain("Allow bash");
		expect(options[0]?.description).toContain("git status -s");
	});

	it("picking a suggested allow option remembers its rule", async () => {
		const home = tempHome();
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = {
			...noopUi(),
			showPermissionDialog: async (request: PermissionDialogRequest) => {
				captured.request = request;
				// 4 base options, then the appended suggestion — index 4.
				return 4;
			},
		} as unknown as ExtensionUIContext;
		const provider = async (): Promise<Suggestion[]> => [allowSuggestion];
		const decision = fakeDecision({ pieces: [pendingPiece("git status -s")] });
		const ctx = fakeCtx(home);
		const res = await promptForDecision(ui, "bash", { command: "git status -s" }, decision, ctx, {
			suggestionsProvider: provider,
		});
		expect(res.policy).toBe("allow");
		expect(res.remembered?.id).toBe("s-allow");
		const file = ruleFiles(ctx.cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.some(r => r.id === "s-allow")).toBe(true);
	});

	it("picking a suggested deny option resolves to deny and remembers it", async () => {
		const home = tempHome();
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = {
			...noopUi(),
			showPermissionDialog: async (request: PermissionDialogRequest) => {
				captured.request = request;
				return 4;
			},
		} as unknown as ExtensionUIContext;
		const provider = async (): Promise<Suggestion[]> => [denySuggestion];
		const decision = fakeDecision({ pieces: [pendingPiece("git push")] });
		const ctx = fakeCtx(home);
		const res = await promptForDecision(ui, "bash", { command: "git push" }, decision, ctx, {
			suggestionsProvider: provider,
		});
		expect(res.policy).toBe("deny");
		expect(res.remembered?.id).toBe("s-deny");
		const file = ruleFiles(ctx.cwd, home).dynamic;
		const doc = YAML.parse(await Bun.file(file).text()) as { rules: Array<Record<string, unknown>> };
		expect(doc.rules.some(r => r.id === "s-deny")).toBe(true);
	});

	it("provider failure degrades to the base options", async () => {
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = capturingDialogUi(captured, 0);
		const provider = async (): Promise<Suggestion[]> => {
			throw new Error("provider down");
		};
		const decision = fakeDecision({ pieces: [pendingPiece("echo a")] });
		const res = await promptForDecision(ui, "bash", { command: "echo a" }, decision, fakeCtx(tempHome()), {
			suggestionsProvider: provider,
		});
		expect(res.policy).toBe("allow");
		expect(await captured.request!.suggestions!).toEqual([]);
	});

	it("does not fire the provider for forced prompts", async () => {
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = capturingDialogUi(captured, 0);
		const provider = vi.fn(async (): Promise<Suggestion[]> => []);
		const decision = fakeDecision({ pieces: [pendingPiece("echo a")] });
		await promptForDecision(ui, "bash", { command: "echo a" }, decision, fakeCtx(tempHome()), {
			includeCandidates: false,
			suggestionsProvider: provider,
		});
		expect(provider).not.toHaveBeenCalled();
		expect(captured.request?.suggestions).toBeUndefined();
	});

	it("an appended option index maps back to the suggestion label", async () => {
		const captured: { request?: PermissionDialogRequest } = {};
		const ui = capturingDialogUi(captured, 4);
		const provider = async (): Promise<Suggestion[]> => [allowSuggestion];
		const decision = fakeDecision({ pieces: [pendingPiece("git status -s")] });
		const res = await promptForDecision(ui, "bash", { command: "git status -s" }, decision, fakeCtx(tempHome()), {
			suggestionsProvider: provider,
		});
		expect(res.policy).toBe("allow");
		expect(res.remembered?.id).toBe("s-allow");
	});
});

describe("renderAllowSuggestion", () => {
	it("a posture-source deny suggests the first allow candidate (no deny rule to beat)", () => {
		const text = renderAllowSuggestion("bash", { command: "git push" }, fakeCtx(tempHome()));
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

	it("non-bash posture keeps the first-candidate fallback", () => {
		const text = renderAllowSuggestion("read", { path: "src/x.ts" }, fakeCtx(tempHome()));
		expect(text).toContain("To allow this call, add rule:");
		const yaml = text.slice(
			text.indexOf("To allow this call, add rule:\n") + "To allow this call, add rule:\n".length,
		);
		const rule = normalizeRule(YAML.parse(yaml), "dynamic");
		expect(rule).not.toBeNull();
		expect(rule!.tool).toBe("read");
		expect(rule!.action).toBe("allow");
		expect((rule!.match as Record<string, unknown>).path).toBe("src/x.ts");
	});

	it("a shell-control bash command is never given a rule suggestion, even with a deny", () => {
		// dynamic file: deny bash "python3 *". R1 degrades allow winners on
		// shell-control commands, so no rule could unblock this call.
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: deny-py\n    tool: bash\n    match: { command: 'python3 *' }\n    action: deny\n",
		);
		const text = renderAllowSuggestion("bash", { command: "python3 -c'x'" }, fakeCtx(home));
		expect(text).toContain("No rule can allow this call");
		expect(text).toContain("shell control");
		expect(text).not.toContain("To allow this call, add rule:");
	});

	it("includes the beating rule YAML and why", () => {
		// dynamic files: deny bash "* | head *" + allow bash "git branch * | head *"
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: deny-pipe\n    tool: bash\n    match: { command: '* | head *' }\n    action: deny\n  - id: allow-git-pipe\n    tool: bash\n    match: { command: 'git branch * | head *' }\n    action: allow\n",
		);
		const text = renderAllowSuggestion("bash", { command: "git branch -a | head -20" }, fakeCtx(home));
		expect(text).toContain("git branch * | head *");
		expect(text).toContain("more specific than");
		expect(text).toContain("action: allow");
		expect(text).toContain("deny-pipe"); // names the deciding deny
	});

	it("with no override explains the dead end", () => {
		// dynamic file: deny bash "* | head *" only
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: deny-pipe\n    tool: bash\n    match: { command: '* | head *' }\n    action: deny\n",
		);
		const text = renderAllowSuggestion("bash", { command: "git branch -a | head -20" }, fakeCtx(home));
		expect(text).toContain("no allow rule can override");
	});

	it("a non-bash deny tie never suggests a rule that cannot win", () => {
		// dynamic files: deny read { path: 'src/x.ts' } + allow read { path: 'src/x.ts' } —
		// equal class and specificity, so deny wins ties.
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: deny-read\n    tool: read\n    match: { path: 'src/x.ts' }\n    action: deny\n  - id: allow-read\n    tool: read\n    match: { path: 'src/x.ts' }\n    action: allow\n",
		);
		const text = renderAllowSuggestion("read", { path: "src/x.ts" }, fakeCtx(home));
		expect(text).toContain("no allow rule can override");
		expect(text).not.toContain("To allow this call, add rule:");
	});

	it("a non-bash allow that strictly beats the deny is suggested", () => {
		// dynamic files: deny read { path: 'src/**' } + allow read { path: 'src/x.ts' } —
		// the exact allow is more specific than the glob deny.
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: deny-read-glob\n    tool: read\n    match: { path: 'src/**' }\n    action: deny\n  - id: allow-read-exact\n    tool: read\n    match: { path: 'src/x.ts' }\n    action: allow\n",
		);
		const text = renderAllowSuggestion("read", { path: "src/x.ts" }, fakeCtx(home));
		expect(text).toContain("more specific than");
		expect(text).toContain("action: allow");
		expect(text).toContain("deny-read-glob"); // names the deciding deny
	});
});

describe("buildDialogLines", () => {
	it("renders summary, operator prefixes, and safe-tail dimming", () => {
		// dynamic rule file: allow bash "echo *" — the middle piece of the
		// compound rides the rule; the two git pieces have no rule (prompt).
		const home = tempHome();
		write(
			path.join(home, ".omp", "agent", "permissions.dynamic.yml"),
			"rules:\n  - id: echo-all\n    tool: bash\n    match: { command: 'echo *' }\n    action: allow\n",
		);
		const ctx = fakeCtx(home);
		const decision = evaluateBashCommand("git log -n 5 | head -1 && echo hi && git status | head -3", ctx);
		const lines = buildDialogLines(decision, decision.pieces, ctx);
		// summary line is accent-styled and counts pending pieces
		expect(lines[0]?.style).toBe("accent");
		expect(lines[0]?.segments[0]?.text).toContain("2 of 3 pieces need approval");
		// second piece row starts with the && operator segment
		const operatorRow = lines.find(line => line.segments.some(segment => segment.text.startsWith("&& ")));
		expect(operatorRow).toBeDefined();
		// safe tail is a dim segment
		const tailSeg = lines.flatMap(line => line.segments).find(segment => segment.text.includes("|head"));
		expect(tailSeg?.dim).toBe(true);
		// status text per v3 wording
		expect(JSON.stringify(lines)).toContain("no rule");
		expect(JSON.stringify(lines)).toContain("allowed · remembered this session");
	});
});
