# Permissions Engine v3 — Precedence, Safe Consumers, Dialog Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the v3 permission-engine redesign: specificity-based rule precedence (deny wins ties, curated hard-denies absolute), a curated safe-consumer exemption for pipeline stages, and the redesigned approval dialog (piece-list-as-command, per-piece drill-down, remember checklists, deny-error suggestions).

**Architecture:** Three layers of change. (1) The engine's decision pipeline (`evaluatePermissionCore`) stops short-circuiting on the first deny and instead resolves the best whole-command rule match by match class (exact-structure > covering), then specificity, then deny-wins-ties, then layer order. (2) Pipeline-stage evaluation gains a curated safe-consumer exemption so one rule covers both bare and piped forms. (3) The approval dialog moves from sequential per-piece prompts to one compound dialog whose piece list *is* the command, with a per-piece drill-down and checklist-based remember sub-dialogs. UI data flows through an extended `PermissionDialogLine`/`PermissionDialogOption` model in the extension types, rendered by `PermissionDialogComponent`.

**Tech Stack:** Bun, TypeScript, `@oh-my-pi/pi-tui` (Container/Text/Loader), brush parser via `@oh-my-pi/pi-natives` (`parseShellCommand`), `bun:test` (tests live in `packages/coding-agent/test/tools/permissions/`).

**Spec:** `docs/superpowers/specs/2026-08-10-tool-permissions-design.md` (v3 update, 2026-08-13). This plan argues from that spec; executors read both.

## Global Constraints

- All work in a git worktree on the permissions feature branch (repo rule: never commit directly on `integration`; conventional commit subjects, e.g. `feat(coding-agent): ...`).
- No `any`; no `ReturnType<>`; no inline/dynamic imports; top-level imports only.
- ES `#private` fields for class privacy; no `private`/`protected`/`public` keywords (constructor parameter properties excepted).
- `Promise.withResolvers()` instead of `new Promise(...)`; `Bun.sleep` not `setTimeout`; namespace imports for `node:*`.
- Never `tsc` — always `bun check` from the package root.
- Tests: contract-level (name the failure mode), deterministic, full-suite-safe (`vi.spyOn` + `vi.restoreAllMocks()` in `afterEach`; never `mock.module()`; never source-grep implementation files).
- Existing engine behaviors that are NOT changing: shell-control degradation of rule allows (ruling R1), legacy `bash.patterns` single-piece allow gate, curated read-only allowlist, PTY whole-command analysis, park/bubble for headless subagents, audit log schema.

---

### Task 1: Match-class and specificity rule resolution

Replaces the deny-first-short-circuit and first-match-allow loops with unified whole-command resolution (spec §3.1 steps 2–3, §3.3).

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/split.ts` (add `isPipeline` export)
- Modify: `packages/coding-agent/src/tools/permissions/engine.ts` (`evaluatePermissionCore`, new helpers)
- Test: `packages/coding-agent/test/tools/permissions/engine.test.ts` (append tests)

**Interfaces:**
- Consumes: `ShellPiece`, `matchRule(rule, toolName, args)`, `isRegexWrapped(pattern)`, `bashCommandArg(args)`, `PermissionRule`, `RuleLayer`, `loadRuleLayers(ctx.cwd, ctx.home)`, `legacyBashPatterns(settings)`.
- Produces:
  - `export type MatchClass = "exact-structure" | "covering"` (engine.ts)
  - `export function isPipeline(command: string): boolean` (split.ts)
  - `export function patternHasPipe(pattern: string): boolean` (engine.ts)
  - `export function patternSpecificity(key: string, pattern: string): number` (engine.ts)
  - `export function matchClassOf(pattern: string, command: string | undefined): MatchClass` (engine.ts)
  - `export interface RuleMatch { rule: PermissionRule; matchClass: MatchClass; specificity: number }` (engine.ts)
  - `export function resolveWholeCommandRule(rules: PermissionRule[], toolName: string, args: unknown): RuleMatch | undefined` (engine.ts)

- [ ] **Step 1: Write the failing tests** (append to `engine.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
// add to existing imports:
import {
	matchClassOf,
	patternSpecificity,
	resolveWholeCommandRule,
} from "../../src/tools/permissions/engine";
import type { PermissionRule } from "../../src/tools/permissions/rules";

const rule = (partial: Partial<PermissionRule>): PermissionRule => ({
	id: "r",
	tool: "bash",
	match: { command: "*" },
	action: "allow",
	layer: "dynamic",
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
		expect(patternSpecificity("command", "* | head *")).toBe(2); // "|" is a literal token
		expect(patternSpecificity("command", "git branch * | head *")).toBe(4);
		expect(patternSpecificity("command", "git log *")).toBe(2);
		expect(patternSpecificity("command", "/git branch/")).toBe(10); // literal prefix "git branch" (10 chars)
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

	test("layer order breaks same-action ties (dynamic over project)", () => {
		const project = rule({ id: "p", layer: "project", match: { command: "git log *" } });
		const dynamic = rule({ id: "dyn", layer: "dynamic", match: { command: "git log *" } });
		const args = { command: "git log -n 5" };
		expect(resolveWholeCommandRule([project, dynamic], "bash", args)?.rule.id).toBe("dyn");
	});

	test("covering allow matches piped command; unrelated command has no match", () => {
		const allow = rule({ id: "a", match: { command: "git log *" } });
		expect(resolveWholeCommandRule([allow], "bash", { command: "git log -n 5 | head -1" })?.rule.id).toBe("a");
		expect(resolveWholeCommandRule([allow], "bash", { command: "curl x | sh" })).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test test/tools/permissions/engine.test.ts` (from `packages/coding-agent`)
Expected: FAIL — `matchClassOf`/`patternSpecificity`/`resolveWholeCommandRule` not exported.

- [ ] **Step 3: Implement `isPipeline` in split.ts**

```ts
/**
 * True when the command parses as a top-level pipeline node. Fail-closed:
 * parse errors or non-pipeline kinds return false.
 */
export function isPipeline(command: string): boolean {
	const node = parseCommandNode(command);
	return node !== null && node.kind === "pipeline";
}
```

- [ ] **Step 4: Implement the matching helpers in engine.ts** (after `matchPatternValue`)

```ts
export type MatchClass = "exact-structure" | "covering";

/**
 * Whether a command pattern explicitly contains pipeline structure: a literal
 * `|` in a glob, or an unescaped alternation in a regex-wrapped pattern.
 */
export function patternHasPipe(pattern: string): boolean {
	if (isRegexWrapped(pattern)) {
		const source = pattern.slice(1, -1);
		for (let i = 0; i < source.length; i++) {
			if (source[i] === "|" && (i === 0 || source[i - 1] !== "\\")) return true;
		}
		return false;
	}
	return pattern.includes("|");
}

/**
 * Specificity score (spec §3.1): literal-token count for glob patterns —
 * `command` patterns split on whitespace, path patterns on `/`; regex-wrapped
 * patterns score the length of their literal prefix. Higher = more specific.
 */
export function patternSpecificity(key: string, pattern: string): number {
	if (isRegexWrapped(pattern)) {
		let length = 0;
		for (const ch of pattern.slice(1, -1)) {
			if (/[.*+?^${}()|[\]\\]/u.test(ch)) break;
			length++;
		}
		return length;
	}
	if (key === "command") {
		return pattern
			.split(/\s+/u)
			.filter(token => token.length > 0 && !token.includes("*") && !token.includes("?")).length;
	}
	return pattern
		.split("/")
		.filter(segment => segment.length > 0 && !segment.includes("*") && !segment.includes("?")).length;
}

/** Match class of a pattern against a command (spec §3.1): same pipeline shape = exact-structure, else covering. */
export function matchClassOf(pattern: string, command: string | undefined): MatchClass {
	if (command === undefined || command.length === 0) return "exact-structure";
	return patternHasPipe(pattern) === isPipeline(command) ? "exact-structure" : "covering";
}

export interface RuleMatch {
	rule: PermissionRule;
	matchClass: MatchClass;
	specificity: number;
}

const LAYER_RANK: Record<RuleLayer, number> = { dynamic: 0, project: 1, user: 2, legacy: 3, curated: 4 };
```

- [ ] **Step 5: Implement `resolveWholeCommandRule` and wire it into `evaluatePermissionCore`**

```ts
/**
 * Best whole-command rule match (spec §3.1 step 2): match class, then
 * specificity, then deny-wins-ties, then layer order. Returns undefined when
 * nothing matches. The caller owns shell-control degradation of allow winners.
 */
export function resolveWholeCommandRule(
	rules: PermissionRule[],
	toolName: string,
	args: unknown,
): RuleMatch | undefined {
	const command = toolName === "bash" ? bashCommandArg(args) : undefined;
	let best: RuleMatch | undefined;
	for (const rule of rules) {
		if (!matchRule(rule, toolName, args)) continue;
		const commandPattern = rule.match.command;
		const matchClass: MatchClass =
			typeof commandPattern === "string" ? matchClassOf(commandPattern, command) : "exact-structure";
		const specKey = typeof commandPattern === "string" ? "command" : (Object.keys(rule.match)[0] ?? "");
		const specificity =
			typeof commandPattern === "string"
				? patternSpecificity("command", commandPattern)
				: patternSpecificity(specKey, String(rule.match[specKey] ?? ""));
		const candidate: RuleMatch = { rule, matchClass, specificity };
		if (best === undefined) {
			best = candidate;
			continue;
		}
		const classRank = (match: RuleMatch): number => (match.matchClass === "exact-structure" ? 1 : 0);
		const layerRank = (r: PermissionRule): number => LAYER_RANK[r.layer] ?? 9;
		const better =
			classRank(candidate) !== classRank(best)
				? classRank(candidate) > classRank(best)
				: candidate.specificity !== best.specificity
					? candidate.specificity > best.specificity
					: candidate.rule.action === best.rule.action
						? layerRank(candidate.rule) < layerRank(best.rule)
						: candidate.rule.action === "deny"; // deny wins ties
		if (better) best = candidate;
	}
	return best;
}
```

In `evaluatePermissionCore`, replace the two file-backed loops (the `for (const rule of rules)` deny loop and the later non-deny loop) AND the `legacyBashPatterns` deny loop with one unified resolution. The legacy pool keeps its single-piece allow gate. Resulting order in the function:

1. tool-declared deny
2. legacy `tools.approval.<tool>` deny
3. curated hard deny (`matchCuratedDeny`) — absolute
4. unified whole-command resolution over `[...legacy, ...rules]`:

```ts
	const legacy = legacyBashPatterns(ctx.settings);
	const legacyAllowActive = legacyAllowEnabled && command !== undefined && isSinglePiece(command);
	const pool = [
		...legacy.filter(rule => rule.action !== "allow" || legacyAllowActive),
		...rules,
	];
	const best = resolveWholeCommandRule(pool, tool.name, args);
	if (best !== undefined) {
		const degraded = best.rule.action === "allow" && bashAllowDegradedByShellControl(tool.name, command);
		return {
			policy: degraded ? "prompt" : best.rule.action,
			tier: decision.tier,
			ruleId: best.rule.id,
			layer: best.rule.layer,
			reason: best.rule.reason,
			source: "rule",
			override: false,
		};
	}
```

5. tool-declared `prompt`/`override`
6. legacy user-policy prompt, then allow
7. curated read-only allowlist
8. default posture

Delete the now-dead `legacy` deny loop and the two `for (const rule of rules)` loops. Keep `legacyAllowEnabled` parameter plumbing unchanged.

- [ ] **Step 6: Run the new tests**

Run: `bun test test/tools/permissions/engine.test.ts`
Expected: PASS.

- [ ] **Step 7: Reconcile the existing suite with the new precedence**

Run: `bun test test/tools/permissions`
For each failure, decide per the precedence table (spec §3.1): behavior intentionally changed (deny-wins-ties replacing deny-absolute; legacy denies now resolve through the pool after curated hard denies) → update the assertion to the new outcome and note the rule in the test comment; true regression → fix the implementation. Legacy attribution assertions (`legacy` layer winning over file rules at equal specificity) are preserved by `LAYER_RANK` (legacy is last), so only deny-absolute-style assertions should need updates.

Run: `bun check` (from `packages/coding-agent`). Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/tools/permissions/split.ts src/tools/permissions/engine.ts test/tools/permissions/engine.test.ts test/tools/permissions/gate.test.ts test/tools/permissions/curated.test.ts
git commit -m "feat(coding-agent): resolve permission rules by match class and specificity"
```

---

### Task 2: Safe-consumer exemption for pipeline stages

Implements spec §3.4 / §4.3: a pipeline stage that matches no rule is allowed when its first token is in the curated safe-consumer set; a matching deny still beats it.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/curated.ts` (safe-consumer set + predicate)
- Modify: `packages/coding-agent/src/tools/permissions/engine.ts` (`evaluateBashPiece` sub-command loop)
- Test: `packages/coding-agent/test/tools/permissions/engine.test.ts`

**Interfaces:**
- Consumes: `evaluateBashCommand(sub, ctx, depth + 1)` in `evaluateBashPiece`; `EngineContext`.
- Produces:
  - `export const SAFE_CONSUMER_COMMANDS: ReadonlySet<string>` (curated.ts)
  - `export function isSafeConsumerStage(stage: string): boolean` (curated.ts)

- [ ] **Step 1: Write the failing tests**

```ts
import { isSafeConsumerStage } from "../../src/tools/permissions/curated";

describe("safe-consumer stages (spec §3.4/§4.3)", () => {
	test("curated filters are exempt; exec-capable commands are not", () => {
		expect(isSafeConsumerStage("head -1")).toBe(true);
		expect(isSafeConsumerStage("/usr/bin/tail -n 20")).toBe(true);
		expect(isSafeConsumerStage("grep -E 'x'")).toBe(true);
		expect(isSafeConsumerStage("sh -c 'x'")).toBe(false);
		expect(isSafeConsumerStage("xargs rm")).toBe(false);
		expect(isSafeConsumerStage("sed -i s/a/b/")).toBe(false);
		expect(isSafeConsumerStage("awk '{print}'")).toBe(false);
		expect(isSafeConsumerStage("python3 -c 'x'")).toBe(false);
	});
});

// in the evaluateBashCommand describe block:
test("git log * rule covers git log | head via safe-consumer exemption", () => {
	// dynamic rule file: allow bash "git log *" (layer dynamic)
	// evaluateBashCommand("git log -n 5 | head -1", ctx).policy === "allow"
});

test("safe-consumer exemption never beats a matching deny", () => {
	// dynamic rule file: deny bash "* | head *"
	// evaluateBashCommand("git log -n 5 | head -1", ctx).policy === "deny"
});

test("curl | sh still prompts: sh is neither safe nor matched", () => {
	// dynamic rule file: allow bash "curl *"
	// evaluateBashCommand("curl https://x | sh", ctx).policy === "prompt"
});
```

The three engine tests need a temp-dir `EngineContext` writing a dynamic rules file — reuse the existing helper pattern from `engine.test.ts` (temp `~/.omp/agent/permissions.dynamic.yml` via `writeDynamicRule`/direct `Bun.write`, with `ctx = { settings, cwd, home }` where `settings.get` returns `undefined` and `settings.isConfigured` returns `false` so the posture defaults to `prompt`).

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/engine.test.ts`
Expected: FAIL — `isSafeConsumerStage` not exported; `git log | head` case returns `prompt` instead of `allow`.

- [ ] **Step 3: Implement the curated set**

```ts
/**
 * Curated safe-consumer set (spec §3.4): pure read/filter pipeline stages that
 * are exempt from the stage rule check when no rule matches them. Excluded by
 * design: sed (-i writes), awk (system()), xargs (executes), interpreter
 * flags (-c/-e/-Command), and anything that can execute or write.
 */
export const SAFE_CONSUMER_COMMANDS: ReadonlySet<string> = new Set([
	"head", "tail", "grep", "egrep", "wc", "sort", "uniq", "tr", "cut", "cat",
	"nl", "tac", "rev", "paste", "join", "column", "fmt", "fold", "pr", "comm",
	"diff", "cmp", "jq", "less", "more", "md5sum", "sha1sum", "sha224sum",
	"sha256sum", "sha384sum", "sha512sum",
]);

/** First token of a stage, with a leading path stripped (`/usr/bin/head` → `head`). */
export function isSafeConsumerStage(stage: string): boolean {
	const token = stage.trim().split(/\s+/u)[0] ?? "";
	const base = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	return SAFE_CONSUMER_COMMANDS.has(base);
}
```

- [ ] **Step 4: Wire the exemption into `evaluateBashPiece`**

In the sub-command loop, between the deny check and the `sawPrompt` record:

```ts
		if (subDecision.policy === "prompt" && subDecision.source === "posture" && isSafeConsumerStage(sub)) {
			// §4.3 safe-consumer exemption: no rule touched this stage, and it is a
			// curated pure filter — treat it as allowed.
			continue;
		}
```

Add the import: `import { CURATED_ALLOW_TOOLS, isSafeConsumerStage, matchCuratedDeny } from "./curated";`

- [ ] **Step 5: Run the tests**

Run: `bun test test/tools/permissions/engine.test.ts`
Expected: PASS — all safe-consumer tests green; existing pipeline tests unchanged (they use explicit rules or non-safe stages).

- [ ] **Step 6: Commit**

```bash
git add src/tools/permissions/curated.ts src/tools/permissions/engine.ts test/tools/permissions/engine.test.ts
git commit -m "feat(coding-agent): exempt curated safe-consumer pipeline stages from rule checks"
```

---

### Task 3: Piece data for the v3 dialog (operator, summary, statuses, near-miss)

Spec §5.1: the piece list is the command — continuation rows carry their operator; statuses read `no rule` / `allowed · remembered this session`; safe-consumer tails are dimmable; a summary line replaces the posture line; near-miss lines only when genuinely close.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/engine.ts` (`PieceEvaluation.operator`, `nearMissLine`, set operator in `evaluateBashPiece`)
- Modify: `packages/coding-agent/src/extensibility/extensions/types.ts` (`PermissionDialogLine`, `PermissionDialogRequest.lines`/`options`, `PermissionDialogOption`)
- Modify: `packages/coding-agent/src/tools/permissions/prompt.ts` (`dialogLines` → `buildDialogLines`, status helpers, safe-tail split)
- Test: `packages/coding-agent/test/tools/permissions/prompt.test.ts`; `packages/coding-agent/test/tools/permissions/engine.test.ts`

**Interfaces:**
- Consumes: `PieceEvaluation`, `ShellPiece["operator"]`, `loadRuleLayers`, `matchRule`, `patternSpecificity`, `SAFE_CONSUMER_COMMANDS`/`isSafeConsumerStage`, `PermissionRule`.
- Produces:
  - `operator?: ShellPiece["operator"]` on `PieceEvaluation` (engine.ts)
  - `export function nearMissLine(pieceText: string, ctx: EngineContext): string | undefined` (engine.ts)
  - `export interface PermissionDialogLine { segments: Array<{ text: string; dim?: boolean }>; style?: "muted" | "text" | "accent" | "allowed" | "denied"; status?: { text: string; style?: "muted" | "text" | "accent" } }` (types.ts)
  - `export interface PermissionDialogOption { label: string; description?: string; checked?: boolean; toggleable?: boolean; labelFor?: (checked: boolean[]) => string }` (types.ts)
  - `PermissionDialogRequest.lines: readonly (string | PermissionDialogLine)[]` (types.ts)
  - `export function buildDialogLines(decision: EngineDecision, pieces: PieceEvaluation[] | undefined, ctx?: EngineContext): PermissionDialogLine[]` (prompt.ts)
  - `export function splitSafeTail(text: string): { prefix: string; tail?: string }` (prompt.ts)

- [ ] **Step 1: Write the failing tests**

```ts
// engine.test.ts
test("piece evaluations carry the top-level operator", () => {
	const decision = evaluateBashCommand("git log -n 5 && git status", ctx);
	const ops = (decision.pieces ?? []).map(piece => piece.operator);
	expect(ops[0]).toBeNull();
	expect(ops[1]).toBe("&&");
});

test("near-miss only reports a genuinely close rule (same first token, narrower)", () => {
	// dynamic rule file: allow bash "git branch -a *"
	expect(nearMissLine("git branch -b new", ctx)).toContain("git branch -a *");
	expect(nearMissLine("git status", ctx)).toBeUndefined(); // echo * style rules are not close
});

// prompt.test.ts
test("buildDialogLines renders summary, operator prefixes, and safe-tail dimming", () => {
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
```

(The test constructs a `decision` via `evaluateBashCommand("git log -n 5 | head -1 && echo hi && git status | head -3", ctx)` with a dynamic rule allowing `echo *`.)

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts`
Expected: FAIL — `operator`/`nearMissLine`/`buildDialogLines` missing; `PermissionDialogLine` type absent.

- [ ] **Step 3: Add `operator` to `PieceEvaluation` and populate it**

In `engine.ts`:

```ts
export interface PieceEvaluation {
	text: string;
	policy: PermissionPolicy;
	ruleId?: string;
	layer?: RuleLayer;
	reason?: string;
	/** Top-level control operator that preceded this piece (bash compounds only). */
	operator?: ShellPiece["operator"];
}
```

In `evaluateBashPiece`, add `operator: piece.operator` to each `evaluation` object it builds (the piece-allow return, the `subs === null` degrade, the deny and sawPrompt returns). For the whole-command fallback in `evaluateBashCommand` (`{ text: command.trim(), operator: null }`), operator is already `null`-shaped via the interface default.

- [ ] **Step 4: Implement `nearMissLine` and `splitSafeTail`**

```ts
// engine.ts
/**
 * Near-miss line (spec §5.1): the closest rule that shares the piece's first
 * token with a narrower glob but does not match it. Undefined when nothing is
 * genuinely close (different command families are never shown).
 */
export function nearMissLine(pieceText: string, ctx: EngineContext): string | undefined {
	const firstToken = pieceText.trim().split(/\s+/u)[0] ?? "";
	if (firstToken.length === 0) return undefined;
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	let best: PermissionRule | undefined;
	let bestSpecificity = 0;
	for (const rule of rules) {
		if (rule.tool !== "bash" && rule.tool !== "*") continue;
		const pattern = rule.match.command;
		if (typeof pattern !== "string" || isRegexWrapped(pattern)) continue;
		const patternToken = pattern.split(/\s+/u)[0] ?? "";
		if (patternToken !== firstToken) continue;
		if (matchRule(rule, "bash", { command: pieceText })) continue; // matches — not a miss
		const specificity = patternSpecificity("command", pattern);
		if (specificity > bestSpecificity) {
			bestSpecificity = specificity;
			best = rule;
		}
	}
	if (best === undefined || best.match.command === undefined) return undefined;
	return `≈ ${best.id}: ${String(best.match.command)} (too narrow for this command)`;
}
```

```ts
// prompt.ts
/** Split a piece at its last pipe; the tail is dimmable when it is a safe consumer. */
export function splitSafeTail(text: string): { prefix: string; tail?: string } {
	const pipeIndex = text.lastIndexOf("|");
	if (pipeIndex < 0) return { prefix: text };
	const tail = text.slice(pipeIndex).trim();
	if (tail.length === 0 || !isSafeConsumerStage(tail)) return { prefix: text };
	return { prefix: text.slice(0, pipeIndex).trimEnd(), tail: ` ${tail}` };
}
```

Add `import { isSafeConsumerStage } from "./curated";` to prompt.ts.

- [ ] **Step 5: Implement `buildDialogLines` in prompt.ts** (replacing `dialogLines`)

```ts
function pieceStatusText(piece: PieceEvaluation): { text: string; style?: "muted" | "text" | "accent" } {
	if (piece.policy === "allow") {
		if (piece.ruleId === undefined) return { text: "allowed" };
		return piece.layer === "dynamic"
			? { text: "allowed · remembered this session", style: "muted" }
			: { text: `allowed · ${piece.layer ?? "rule"} rule ${piece.ruleId}`, style: "muted" };
	}
	if (piece.policy === "deny") return { text: "denied", style: "accent" };
	return piece.ruleId !== undefined
		? { text: `prompt · rule ${piece.ruleId}`, style: "accent" }
		: { text: "no rule", style: "accent" };
}

/** v3 dialog lines (spec §5.1): summary, operator-prefixed piece rows, dim safe tails, near-miss. */
export function buildDialogLines(
	decision: EngineDecision,
	pieces: PieceEvaluation[] | undefined,
	ctx?: EngineContext,
): PermissionDialogLine[] {
	const lines: PermissionDialogLine[] = [];
	if (pieces !== undefined && pieces.length > 0) {
		const pending = pieces.filter(piece => piece.policy === "prompt").length;
		if (pieces.length > 1) {
			lines.push({
				segments: [
					{ text: `${pending} of ${pieces.length} pieces need approval — no rule covers this command` },
				],
				style: "accent",
			});
		}
		for (const [index, piece] of pieces.entries()) {
			const { prefix, tail } = splitSafeTail(piece.text);
			const segments: Array<{ text: string; dim?: boolean }> = [];
			const operator = index > 0 && piece.operator !== undefined && piece.operator !== null ? `${piece.operator} ` : "";
			segments.push({ text: `${operator}${prefix}` });
			if (tail !== undefined) segments.push({ text: tail, dim: true });
			const status = pieceStatusText(piece);
			const line: PermissionDialogLine = {
				segments,
				style: piece.policy === "allow" ? "allowed" : piece.policy === "deny" ? "denied" : "text",
				status,
			};
			lines.push(line);
			if (piece.policy === "prompt" && ctx !== undefined) {
				const miss = nearMissLine(piece.text, ctx);
				if (miss !== undefined) lines.push({ segments: [{ text: miss }], style: "muted" });
			}
		}
		return lines;
	}
	// Single-unit (non-bash / PTY) context line, v3 wording.
	lines.push({
		segments: [
			{ text: decision.ruleId !== undefined ? `rule ${decision.ruleId}${decision.layer ? ` (${decision.layer})` : ""}` : "no rule" },
		],
		style: decision.ruleId !== undefined ? "muted" : "accent",
	});
	return lines;
}
```

Delete `dialogLines`, `pieceStatus`, `pieceStatusLine`; update callers (`promptUnit`, `chooseLabel` fallback) to pass `(string | PermissionDialogLine)[]` — existing string call sites still typecheck via the union.

- [ ] **Step 6: Define the line/option types in `extensibility/extensions/types.ts`**

```ts
/** One rendered line of the permission dialog: text segments (safe tails dimmable) plus an optional right-aligned status. */
export interface PermissionDialogLine {
	segments: Array<{ text: string; dim?: boolean }>;
	style?: "muted" | "text" | "accent" | "allowed" | "denied";
	status?: { text: string; style?: "muted" | "text" | "accent" };
}

export interface PermissionDialogOption {
	label: string;
	description?: string;
	/** Checklist mode: starts checked. */
	checked?: boolean;
	/** Checklist mode: space toggles this option. */
	toggleable?: boolean;
	/** Checklist mode: recompute the label from the current checked array (write button count). */
	labelFor?: (checked: boolean[]) => string;
}
```

Update `PermissionDialogRequest`: `lines?: readonly (string | PermissionDialogLine)[];` and `options: PermissionDialogOption[];` plus `initialIndex?: number;` and `checklist?: boolean;` and `allowEdit?: boolean;`. Keep `suggestions?: Promise<PermissionDialogOption[]>`.

- [ ] **Step 7: Run tests and `bun check`**

Run: `bun test test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts` then `bun check`
Expected: PASS, no type errors. (`prompt.test.ts` existing tests may need their expected line strings updated to the new wording — update them to the v3 strings.)

- [ ] **Step 8: Commit**

```bash
git add src/tools/permissions/engine.ts src/tools/permissions/prompt.ts src/extensibility/extensions/types.ts test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts
git commit -m "feat(coding-agent): v3 permission dialog line data (operator prefixes, statuses, near-miss)"
```

---

### Task 4: Dialog component v3 rendering (segments, statuses, preselect, truncation, checklist)

Renders the new line model; adds `l` expand, `space` checklist toggling, `e` edit request, and `initialIndex` preselection (spec §5.1).

**Files:**
- Modify: `packages/coding-agent/src/modes/components/permission-dialog.ts`
- Modify: `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` (`showPermissionDialog` opts plumbing)
- Test: `packages/coding-agent/test/modes/components/permission-dialog.test.ts`

**Interfaces:**
- Consumes: `PermissionDialogLine`, `PermissionDialogOption`, `PermissionDialogRequest` (Task 3 types); `theme` (`fg`, `bg`, `dim` keys); `matchesSelectCancel/Up/Down`, `matchesKey`; `DynamicBorder`.
- Produces: constructor `opts` additions: `initialIndex?: number` (`-1`/omitted = no selection, Enter no-op until navigation; `>= 0` preselects — Task 6's Pattern preselect), `checklist?: boolean; allowEdit?: boolean; onEdit?: (index: number) => void; previewFor?: (checked: boolean[]) => string`; `#sourceOptions` reference with checked-state write-back; `DEFAULT_HELP_TEXT` updated to `j/k navigate  enter select  esc cancel — no rule written`.

- [ ] **Step 1: Write the failing component tests**

```ts
// permission-dialog.test.ts — follow existing harness in this file (mount with a fake TUI, feed keys, capture selection)
test("renders line segments with dim tails and right-aligned status", () => {
	// construct component with lines=[{ segments: [{text:"git log"}, {text:" |head -1", dim:true}], style:"text", status:{text:"no rule"} }]
	// render(100) → text rows: dim segment contains "|head", status "no rule" present
});

test("initialIndex preselects an option (enter picks it)", () => {
	// options A/B, initialIndex 1 → enter → onSelect(1)
});

test("checklist mode: space toggles checked and labelFor rewrites the label", () => {
	// options: [{label:"git log *", toggleable:true, checked:true}, {labelFor: (c)=>`Write checked (${c.length})`}]
	// space on row 0 → label of option 1 becomes "Write checked (0)"
});

test("l toggles line truncation; truncated lines end with …", () => {
	// long line (> width) → render shows truncated text; press l → full text
});

test("e triggers onEdit when allowEdit is set", () => {
	// allowEdit + e key → onEdit called; without allowEdit → ignored
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/modes/components/permission-dialog.test.ts`
Expected: FAIL — new opts unsupported, segments unrendered.

- [ ] **Step 3: Implement rendering of the new line model**

Replace the `for (const line of lines)` block in the constructor: keep a private `#lines: PermissionDialogLine[]` (string entries converted to `{ segments: [{ text }] }`) and a `#lineContainer: Container` so lines can re-render on expand/width change. Update `DEFAULT_HELP_TEXT` to `j/k navigate  enter select  esc cancel — no rule written` (spec §5.1). Render each line as:

```ts
#renderLines(): void {
	this.#lineContainer.clear();
	const available = Math.max(20, this.#lastRenderWidth - 4);
	for (const line of this.#lines) {
		const style = line.style ?? "muted";
		const styleColor = style === "accent" ? "accent" : style === "text" ? "text" : style === "allowed" ? "muted" : "dim";
		let text = "";
		for (const segment of line.segments) {
			text += segment.dim === true ? theme.fg("dim", segment.text) : theme.fg(styleColor, segment.text);
		}
		if (!this.#expanded && text.replace(/\x1b\[[0-9;]*m/gu, "").length > available) {
			// truncate on the plain text, then re-apply styling is complex; simpler: truncate each segment's plain text
		}
		// status: pad to available width
		if (line.status !== undefined) {
			const plain = line.segments.map(segment => segment.text).join("");
			const pad = Math.max(1, available - plain.length);
			text += " ".repeat(pad) + theme.fg(line.status.style === "accent" ? "accent" : "muted", line.status.text);
		}
		this.#lineContainer.addChild(new Text(text, 1, 0));
	}
}
```

Truncation: implement on the **plain concatenation** before styling — build the plain string first, truncate to `available` with `…` when `#expanded` is false, then re-split styling by walking segments. To keep it simple and correct: truncate per-segment plain text sequentially (each segment keeps its own style); the plan's acceptance is "long lines end with … and `l` reveals the full text". Verify visually in the tmux smoke (Task 9).

Add `#expanded = false`; in `handleInput`, add:

```ts
		if (matchesKey(keyData, "l")) {
			this.#expanded = !this.#expanded;
			this.#renderLines();
			return;
		}
```

- [ ] **Step 4: Implement checklist mode, `initialIndex`, and `e`**

Constructor `opts`:

```ts
		this.#selectedIndex = opts.initialIndex ?? 0;
		this.#checklist = opts.checklist === true;
		this.#onEdit = opts.onEdit;
		this.#previewFor = opts.previewFor;
		// Keep the caller's array so toggled state can be written back (Task 6 reads it).
		this.#sourceOptions = options;
		this.#checked = this.#options.map(option => option.checked ?? false);
```

`handleInput` additions:

```ts
		if (this.#checklist && matchesKey(keyData, " ")) {
			const option = this.#options[this.#selectedIndex];
			if (option?.toggleable === true) {
				this.#checked[this.#selectedIndex] = !(this.#checked[this.#selectedIndex] ?? false);
				// Write back onto the source option object so the caller can read final state.
				const source = this.#sourceOptions[this.#selectedIndex];
				if (source !== undefined) source.checked = this.#checked[this.#selectedIndex];
				if (option.labelFor !== undefined) option.label = option.labelFor(this.#checked);
				if (this.#previewFor !== undefined) this.#previewText.setText(this.#previewFor(this.#checked));
				this.#renderList();
				this.#renderPreview();
			}
			return;
		}
		if (matchesKey(keyData, "e") && this.#onEdit !== undefined && this.#checklist) {
			this.#settled = true;
			this.#onEdit(this.#selectedIndex);
			return;
		}
```

`#renderList`: for checklist rows, prefix the label with `[x] ` / `[ ] ` when `toggleable`; the label is stored **without** the prefix. Add `#previewText: Text` child (below the list, above the help line) rendered from `previewFor(this.#checked)` when provided; empty string hides it.

- [ ] **Step 5: Plumb the new opts through `extension-ui-controller.showPermissionDialog`**

`PermissionDialogRequest` gains `previewFor?: (checked: boolean[]) => string`.

```ts
			this.ctx.permissionDialog = new PermissionDialogComponent(
				request.title,
				request.lines ?? [],
				request.options,
				index => settle(index),
				() => settle(undefined),
				{
					maxVisible,
					initialIndex: request.initialIndex,
					checklist: request.checklist,
					allowEdit: request.allowEdit,
					previewFor: request.previewFor,
					...(request.allowEdit === true ? { onEdit: index => settle(-(index + 2)) } : {}),
					...(request.suggestions !== undefined ? { suggestions: request.suggestions, ui: this.ctx.ui } : {}),
				},
			);
```

Sentinels: `-1` = plain cancel; `-(index + 2)` = edit request for checklist row `index`. `chooseLabel` returns the raw index; `prompt.ts` maps them (Task 6).

- [ ] **Step 6: Parked-approval UX feedback (user UX findings, 2026-08-13)**

Two gaps in the focused-view answering flow, both fixed in `permission-controller.ts`:

(a) **Waiting notice is not noticeable** — the root notification fires as a default gray info notice and the user missed it for ~25 minutes. Change `#handleParked`'s notify call to pass the `"warning"` type (same mechanism as the migration notices):

```ts
		this.#deps.ui()?.notify(`Subagent ${agentLabel} is waiting for approval: ${command}`, "warning");
```

(b) **No answer feedback** — after `promptForDecision` resolves a parked approval, the pending entry keeps its "waiting" heading. Add to `#presentFor`, after `answer(...)`:

```ts
			this.#deps.ui()?.notify(
				`Approval answered: ${resolution.policy === "allow" ? "allowed" : "denied"} — ${agentLabel} resumed`,
			);
```

Tests in `bubble.test.ts`: (a) the "notifies the root …" test asserts `h.notify` was called with the waiting message and `"warning"` as the type; (b) after the parked promise resolves, assert `h.notify` was called with a message containing `Approval answered` and the resolved policy.

- [ ] **Step 7: No-default-selection mode (user UX finding, 2026-08-13, controller-ruled)**

The Enter that switches focus to a parked subagent can also confirm the just-presented dialog (selected index defaults to 0 = Allow once) — an unread command gets silently approved. Implement true no-selection in `PermissionDialogComponent`:

- `initialIndex: -1` (or omitted → default `-1`): render **no** selected row (no `selectedBg` highlight on any option) and **Enter is a no-op** until `j`/`k`/up/down first moves the selection (then normal behavior).
- `initialIndex >= 0` keeps the existing behavior (used by the remember sub-dialogs' Pattern preselect, Task 6).
- `#selectedIndex` starts at -1; `#moveSelection` clamps to `[0, options.length - 1]` on first move; `#renderList` skips the highlight when `#selectedIndex < 0`; `handleInput` enter branch returns early when `#selectedIndex < 0`.

Component tests: (a) `initialIndex` omitted/`-1` → render shows no highlighted row and enter calls neither `onSelect` nor `onCancel`; (b) after `j`, enter selects option 1; (c) `initialIndex: 1` still preselects (existing test unchanged).

- [ ] **Step 8: Run tests and `bun check`**

Run: `bun test test/modes/components/permission-dialog.test.ts test/tools/permissions/bubble.test.ts` and `bun check`
Expected: PASS, no type errors. Reconcile existing component tests whose assertions depended on the old plain-string line rendering (they should still pass — old strings are a subset of the new union). Existing tests that press enter immediately without navigation must be updated to press `j` first.

- [ ] **Step 9: Commit**

```bash
git add src/modes/components/permission-dialog.ts src/modes/controllers/extension-ui-controller.ts src/extensibility/extensions/types.ts test/modes/components/permission-dialog.test.ts
git commit -m "feat(coding-agent): permission dialog v3 rendering (segments, preselect, checklist, expand)"
```

---

### Task 5: Main dialog flow v3 — one compound dialog with drill-down

Spec §5.1: `promptForDecision` shows ONE dialog for the whole call. Actions: `Allow all pending once` / `Allow all & remember…` / `Deny all pending` / `Decide per piece →`. No preselection on this dialog. `esc` = cancel — no rule written. PTY/non-bash/forced prompts keep the single-unit flow.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/prompt.ts`
- Test: `packages/coding-agent/test/tools/permissions/prompt.test.ts`

**Interfaces:**
- Consumes: `promptUnit`, `chooseLabel`, `buildDialogLines` (Task 3), `buildCandidates`, `PromptResolution`, `evaluateBashCommand`.
- Produces:
  - `const ALLOW_ALL_ONCE = "Allow all pending once"` / `ALLOW_ALL_REMEMBER = "Allow all & remember…"` / `DENY_ALL = "Deny all pending"` / `DRILL_DOWN = "Decide per piece →"`
  - `export async function rememberCompound(ui: ExtensionUIContext, pendingPieces: PieceEvaluation[], action: "allow" | "deny", ctx: EngineContext): Promise<Omit<PermissionRule, "layer"> | undefined>` — Task 6; Task 5 calls it with this exact 4-arg shape (defined next task — implement a minimal exported version in Task 5 so the flow is testable; Task 6 replaces it with the full checklist).
  - `function drillDownPieces(ui, toolName, pendingPieces, decision, ctx, opts): Promise<PromptResolution>` (piece selector → per-piece `promptUnit`)

- [ ] **Step 1: Write the failing tests**

```ts
// prompt.test.ts — mock `ui` with showPermissionDialog returning scripted indices; assert option labels and routing
test("compound command prompts once with v3 actions", async () => {
	// evaluateBashCommand("git log -n 5 && echo hi") with echo rule → decision.pieces has 1 pending
	// ui.showPermissionDialog captures request; script index 0 (Allow all pending once)
	// expect request.options.map(o => o.label) toEqual([
	//   "Allow all pending once", "Allow all & remember…", "Deny all pending", "Decide per piece →"
	// ])
	// resolution.policy === "allow"
});

test("Deny all pending denies the call", async () => {
	// script index 2 → resolution.policy === "deny"
});

test("drill-down denies when any piece is denied", async () => {
	// script: index 3 (Decide per piece →), then the piece selector (index 0), then per-piece dialog index 2 (Deny once)
	// resolution.policy === "deny"
});

test("esc (undefined) on the main dialog denies without a rule", async () => {
	// script undefined → resolution.policy === "deny", remembered === undefined
});

test("PTY and non-bash calls keep the single-unit flow", async () => {
	// pty:true args → options are the old single-unit four (Allow once / Allow & remember… / Deny / Deny & remember…)
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/prompt.test.ts`
Expected: FAIL — v3 options not present.

- [ ] **Step 3: Restructure `promptForDecision`**

```ts
const ALLOW_ALL_ONCE = "Allow all pending once";
const ALLOW_ALL_REMEMBER = "Allow all & remember…";
const DENY_ALL = "Deny all pending";
const DRILL_DOWN = "Decide per piece →";

export async function promptForDecision(
	ui: ExtensionUIContext,
	toolName: string,
	args: unknown,
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions = {},
): Promise<PromptResolution> {
	const ptyCall = isPtyCall(args);

	let pieces = decision.pieces;
	if (pieces === undefined && toolName === "bash" && !ptyCall) {
		const command = argString(args, "command");
		if (command !== undefined) pieces = evaluateBashCommand(command, ctx).pieces;
	}
	const pendingPieces = (pieces ?? []).filter(piece => piece.policy === "prompt");

	// Single-unit flows: PTY, non-bash, forced prompts, or nothing pending.
	if (ptyCall || pieces === undefined || pieces.length <= 1 || pendingPieces.length === 0) {
		return promptUnit(ui, toolName, args, decision, ctx, opts, pieces);
	}

	// v3 compound flow: one dialog for the whole call (spec §5.1).
	const title = opts.title ?? defaultTitle(toolName, decision);
	const lines = buildDialogLines(decision, pieces, ctx);
	const suggestionsPromise =
		opts.suggestionsProvider !== undefined
			? opts.suggestionsProvider(unitPieceText(toolName, args)).then(resolveSuggestions).catch(() => ({ options: [], byLabel: new Map<string, Suggestion>() }))
			: undefined;
	const rememberDisabled = pendingPieces.some(piece => bashRememberDisabled({ command: piece.text }));
	const baseOptions = rememberDisabled
		? [ALLOW_ALL_ONCE, DENY_ALL]
		: [ALLOW_ALL_ONCE, ALLOW_ALL_REMEMBER, DENY_ALL, DRILL_DOWN];
	const chosen = await chooseLabel(ui, title, baseOptions, lines, suggestionsPromise?.then(result => result.options));
	switch (chosen) {
		case ALLOW_ALL_ONCE:
			return { policy: "allow" };
		case DENY_ALL:
			return { policy: "deny" };
		case ALLOW_ALL_REMEMBER: {
			const rule = await rememberCompound(ui, pendingPieces, "allow", ctx);
			return rule === undefined ? { policy: "deny" } : { policy: "allow", remembered: rule };
		}
		case DENY_ALL_REMEMBER: {
			const rule = await rememberCompound(ui, pendingPieces, "deny", ctx);
			return rule === undefined ? { policy: "deny" } : { policy: "deny", remembered: rule };
		}
		case DRILL_DOWN:
			return drillDownPieces(ui, pendingPieces, decision, ctx, opts);
		default:
			// Suggestion option picked from the dialog (appended options).
			if (chosen !== undefined && suggestionsPromise !== undefined) {
				const picked = (await suggestionsPromise).byLabel.get(chosen);
				if (picked !== undefined) {
					await writeRememberedRule(picked.rule, ctx);
					return { policy: picked.rule.action === "allow" ? "allow" : "deny", remembered: picked.rule };
				}
			}
			return { policy: "deny" };
	}
}
```

Note: `chooseLabel`'s `lines` parameter is `readonly (string | PermissionDialogLine)[]` per Task 3 — `buildDialogLines` output passes directly. Per the no-selection ruling (Task 4 Step 7), `chooseLabel`'s `PermissionDialogRequest` includes `initialIndex: -1` by default — the permission dialog never pre-selects an option, so a stray Enter (e.g. the focus-switch press) cannot confirm anything. Remember-scope dialogs override with their explicit preselect (Task 6).

- [ ] **Step 4: Implement `drillDownPieces`**

```ts
/** Per-piece drill-down (spec §5.1): pick a pending piece, decide it, repeat; Back leaves the rest denied. */
async function drillDownPieces(
	ui: ExtensionUIContext,
	pendingPieces: PieceEvaluation[],
	decision: EngineDecision,
	ctx: EngineContext,
	opts: PromptForDecisionOptions,
): Promise<PromptResolution> {
	let remembered: Omit<PermissionRule, "layer"> | undefined;
	const remaining = [...pendingPieces];
	while (remaining.length > 0) {
		const options = remaining.map(piece => ({ label: piece.text }));
		const picked = await chooseLabel(ui, "Decide per piece", ["Back", ...remaining.map(piece => piece.text)]);
		if (picked === undefined || picked === "Back") break; // remaining pieces stay denied
		const index = remaining.findIndex(piece => piece.text === picked);
		if (index < 0) break;
		const [piece] = remaining.splice(index, 1);
		const resolution = await promptUnit(ui, "bash", { command: piece.text }, decision, ctx, opts, [piece]);
		if (resolution.policy === "deny" && resolution.remembered === undefined) {
			// fail closed: a denied piece denies the whole call
			return { policy: "deny" };
		}
		if (resolution.remembered !== undefined) remembered = resolution.remembered;
	}
	return remembered !== undefined ? { policy: "allow", remembered } : { policy: "allow" };
}
```

(Drill-down allows the decided pieces; undecided remainders fail closed to deny per the spec's cancel semantics. A `Deny once` on a piece denies the whole call — matching "any piece denied → whole call denied".)

- [ ] **Step 5: Run tests and `bun check`**

Run: `bun test test/tools/permissions/prompt.test.ts` and `bun check`
Expected: PASS. Existing prompt tests asserting the sequential per-piece flow are rewritten to the compound flow (update assertions; the single-unit paths are unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/tools/permissions/prompt.ts test/tools/permissions/prompt.test.ts
git commit -m "feat(coding-agent): one compound approval dialog with per-piece drill-down"
```

---

### Task 6: Remember sub-dialogs v3 — compound checklist and single-piece scope

Spec §5.1 remember dialogs: compound = per-piece checklist (`[x]` rows, space toggles, `e` edits a glob, live YAML preview, `Write checked rules (N)`, preselected — Enter writes); single piece = `Exact call` / `Pattern` (preselected) / `Custom…`; `Tool always` only for read-only tools (`CURATED_ALLOW_TOOLS`), never bash. Dialog index sentinels: `-1` = plain cancel, `-(index + 2)` = edit request for checklist row `index` (Task 4 Step 5); both route through `ui.input` for editing.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/prompt.ts`
- Test: `packages/coding-agent/test/tools/permissions/prompt.test.ts`

**Interfaces:**
- Consumes: `chooseLabel`, `chooseCandidate`, `candidate`, `candidateRuleId`, `writeRememberedRule`, `ui.input(title, placeholder)`, `CURATED_ALLOW_TOOLS` (curated.ts), `splitSafeTail` (Task 3).
- Produces:
  - `export async function rememberCompound(ui: ExtensionUIContext, pendingPieces: PieceEvaluation[], action: "allow" | "deny", ctx: EngineContext): Promise<Omit<PermissionRule, "layer"> | undefined>` — returns the first written rule (for `PromptResolution.remembered`) or undefined on cancel. Writes one dynamic rule per checked piece (first-token globs).
  - `function toolWideAllowed(toolName: string): boolean` — `(CURATED_ALLOW_TOOLS as readonly string[]).includes(toolName)`

- [ ] **Step 1: Write the failing tests**

```ts
test("rememberCompound builds first-token globs, preselects all, writes checked rules", async () => {
	// pendingPieces = [git log -n 5, git status] with a temp dynamic file
	// ui.showPermissionDialog script: checklist request with 2 toggleable options + write option
	//   - assert request.checklist === true, request.initialIndex === 1 (write option preselected? see below)
	//   - assert option 0: { label: "git log *", checked: true, toggleable: true }, labelFor produces "Write checked rules (2)"
	//   - script: select the write option (index 1) → rules written to the dynamic file: "git log *" and "git status *"
	// resolve → remembered !== undefined
});

test("single-piece scope: Pattern is preselected and Tool always is absent for bash", async () => {
	// promptUnit on bash piece; Allow & remember… → scope dialog request
	// expect request.initialIndex === 1 (Pattern)
	// expect request.options labels: Exact call / Pattern: git branch * / Custom…
	// (no "Tool always")
});

test("Tool always is offered for read-only tools", async () => {
	// promptUnit on read tool → scope dialog includes "Tool: read always"
});

test("e sentinel (-2) edits the row-0 glob via ui.input", async () => {
	// ui.showPermissionDialog script: -2 (edit row 0), then ui.input returns "git log -5 *"
	// final written rule match is { command: "git log -5 *" }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/prompt.test.ts`
Expected: FAIL — `rememberCompound` missing; bash scope still offers Tool always.

- [ ] **Step 3: Implement `toolWideAllowed` and remember-scope gating in `scopedCandidates`**

```ts
/** Tool-always scope is offered only for read-only tools (spec §5.1); never for bash/exec tools. */
function toolWideAllowed(toolName: string): boolean {
	return (CURATED_ALLOW_TOOLS as readonly string[]).includes(toolName);
}
```

In `bashCandidates` and `fileCandidates`, drop the tool candidate when `!toolWideAllowed(toolName)`. `genericCandidates` likewise. Import `CURATED_ALLOW_TOOLS` from `./curated`.

- [ ] **Step 4: Implement `rememberCompound`**

```ts
/** Compound remember dialog (spec §5.1): per-piece first-token glob checklist with live YAML preview. */
export async function rememberCompound(
	ui: ExtensionUIContext,
	pendingPieces: PieceEvaluation[],
	action: "allow" | "deny",
	ctx: EngineContext,
): Promise<Omit<PermissionRule, "layer"> | undefined> {
	const toRule = (piece: PieceEvaluation): CandidateRule => {
		const firstToken = piece.text.trim().split(/\s+/u)[0] ?? "";
		const pattern = `${firstToken} *`;
		return candidate("bash", action, "pattern", { command: pattern }, `${pattern}`);
	};
	const buildOptions = (pieces: PieceEvaluation[]): PermissionDialogOption[] => {
		const options: PermissionDialogOption[] = pieces.map(piece => {
			const rule = toRule(piece);
			return {
				label: rule.rule.match.command as string,
				description: piece.text,
				checked: true,
				toggleable: true,
			};
		});
		options.push({
			label: `Write checked ${action === "allow" ? "allow" : "deny"} rules (${pieces.length})`,
			labelFor: checked => `Write checked ${action === "allow" ? "allow" : "deny"} rules (${checked.filter(Boolean).length})`,
		});
		return options;
	};
	const previewFor = (checked: boolean[]): string =>
		checked
			.map((on, index) => (on ? renderCandidateYaml(toRule(pendingPieces[index]!).rule) : ""))
			.filter(Boolean)
			.join("\n");

	const request: PermissionDialogRequest = {
		title: `Remember ${action === "allow" ? "allow" : "deny"} — what rule?`,
		lines: [
			{
				segments: [{ text: `${pendingPieces.length} pending pieces — an exact match would never fire again, so:` }],
				style: "muted",
			},
		],
		options: buildOptions(pendingPieces),
		checklist: true,
		allowEdit: true,
		previewFor,
	};
	const index = await ui.showPermissionDialog?.(request);
	if (index === -1 || index === undefined) return undefined; // plain cancel
	if (index < -1) {
		// e: edit the selected piece's glob, then write the edited rule directly.
		const pieceIndex = -index - 2;
		const piece = pendingPieces[pieceIndex];
		if (piece === undefined || ui.input === undefined) return undefined;
		const current = toRule(piece).rule.match.command as string;
		const edited = await ui.input(`Edit glob for ${piece.text}`, current);
		if (edited === undefined || edited.trim().length === 0) return undefined;
		const rule = candidate("bash", action, "pattern", { command: edited.trim() }, edited.trim());
		await writeRememberedRule(rule.rule, ctx);
		return rule.rule;
	}
	const picked = request.options[index];
	if (picked === undefined || picked.labelFor === undefined) return undefined; // piece row picked — no write
	// The component wrote checked state back onto the request's option objects
	// (Task 4 Step 4), so read the final state from the request.
	const written: Array<Omit<PermissionRule, "layer">> = [];
	for (const option of request.options) {
		if (option.toggleable === true && option.checked === true) {
			written.push(candidate("bash", action, "pattern", { command: option.label }, option.label).rule);
		}
	}
	if (written.length === 0) return undefined;
	for (const rule of written) await writeRememberedRule(rule, ctx);
	return written[0];
}
```

**Note:** the component writes checked state back onto the source option objects (Task 4 Step 4), so `request.options` reflects the final state. The `previewFor`/`labelFor` callbacks receive the `#checked` array.

- [ ] **Step 5: Single-piece scope preselection**

In `chooseCandidate`, pass `initialIndex` for the recommended scope: pattern when present (index of the first `scope === "pattern"` candidate), else exact (0). `CandidateRule` gains `scope: CandidateScope` (set in `candidate(...)`) so `chooseCandidate` can find it:

```ts
		const request: PermissionDialogRequest = {
			title,
			options: candidates.map(candidateItem => ({ label: candidateItem.label, description: candidateItem.yaml })),
			initialIndex: Math.max(0, candidates.findIndex(candidateItem => candidateItem.scope === "pattern")),
		};
```

- [ ] **Step 6: Run tests and `bun check`**

Run: `bun test test/tools/permissions/prompt.test.ts` and `bun check`
Expected: PASS. Reconcile existing remember-flow tests (bash scope no longer includes Tool always — update assertions).

- [ ] **Step 7: Commit**

```bash
git add src/tools/permissions/prompt.ts test/tools/permissions/prompt.test.ts
git commit -m "feat(coding-agent): remember dialogs v3 (compound checklist, scope preselect, no tool-wide bash)"
```

---

### Task 7: Deny-error structured suggestion

Spec §5.2: the model-visible deny error suggests a more-specific whole-command allow when one would beat the denying rule, with the exact YAML and why it wins. Denied calls still never open a dialog.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/engine.ts` (`denyOverrideSuggestion`)
- Modify: `packages/coding-agent/src/tools/permissions/prompt.ts` (`renderAllowSuggestion`)
- Test: `packages/coding-agent/test/tools/permissions/prompt.test.ts`; `packages/coding-agent/test/tools/permissions/engine.test.ts`

**Interfaces:**
- Consumes: `loadRuleLayers`, `resolveWholeCommandRule`, `patternSpecificity`, `matchClassOf`, `bashCommandArg`, `renderCandidateYaml`, `buildCandidates`.
- Produces:
  - `export interface DenyOverride { rule: PermissionRule; matchClass: MatchClass; specificity: number }` (engine.ts)
  - `export function denyOverrideSuggestion(command: string, ctx: EngineContext): DenyOverride | undefined` (engine.ts) — best allow-only whole-command match that strictly beats the best deny (class first, then specificity), else undefined.

- [ ] **Step 1: Write the failing tests**

```ts
// engine.test.ts
test("denyOverrideSuggestion finds an allow that beats a general deny", () => {
	// dynamic file: deny bash "* | head *"
	// denyOverrideSuggestion("git branch -a | head -20", ctx)
	//   → undefined (no allow rule exists yet)
});

test("denyOverrideSuggestion reports the candidate allow when one would win", () => {
	// dynamic file: deny bash "* | head *" AND allow bash "git branch * | head *"
	// denyOverrideSuggestion("git branch -a | head -20", ctx)?.rule.match.command === "git branch * | head *"
});

// prompt.test.ts
test("renderAllowSuggestion includes the beating rule YAML and why", () => {
	// same dynamic files; renderAllowSuggestion("bash", { command: "git branch -a | head -20" })
	//   → contains "git branch * | head *", contains "more specific than", contains "action: allow"
});

test("renderAllowSuggestion with no override explains the dead end", () => {
	// only the deny exists → contains "no allow rule can override"
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement `denyOverrideSuggestion`**

```ts
export interface DenyOverride {
	rule: PermissionRule;
	matchClass: MatchClass;
	specificity: number;
}

const BASH_COMMAND_ARGS = (command: string): Record<string, unknown> => ({ command });

/**
 * When a deny wins (spec §5.2): the best allow-only whole-command rule that
 * strictly beats the deciding deny by class then specificity — the exact rule
 * the user can add to permit this call. Undefined when no allow can win.
 */
export function denyOverrideSuggestion(command: string, ctx: EngineContext): DenyOverride | undefined {
	const { rules } = loadRuleLayers(ctx.cwd, ctx.home);
	const args = BASH_COMMAND_ARGS(command);
	const best = resolveWholeCommandRule(rules, "bash", args);
	if (best === undefined || best.rule.action !== "deny") return undefined;
	const classRank = (matchClass: MatchClass): number => (matchClass === "exact-structure" ? 1 : 0);
	let bestAllow: DenyOverride | undefined;
	for (const rule of rules) {
		if (rule.action !== "allow" || !matchRule(rule, "bash", args)) continue;
		const commandPattern = rule.match.command;
		if (typeof commandPattern !== "string") continue;
		const matchClass = matchClassOf(commandPattern, command);
		const specificity = patternSpecificity("command", commandPattern);
		const beats =
			classRank(matchClass) !== classRank(best.matchClass)
				? classRank(matchClass) > classRank(best.matchClass)
				: specificity > best.specificity;
		if (!beats) continue;
		if (
			bestAllow === undefined ||
			classRank(matchClass) > classRank(bestAllow.matchClass) ||
			(classRank(matchClass) === classRank(bestAllow.matchClass) && specificity > bestAllow.specificity)
		) {
			bestAllow = { rule, matchClass, specificity };
		}
	}
	return bestAllow;
}
```

- [ ] **Step 4: Rewrite `renderAllowSuggestion`**

```ts
export function renderAllowSuggestion(toolName: string, args: unknown): string {
	const command = argString(args, "command");
	if (toolName === "bash" && command !== undefined && command.length > 0 && args !== undefined) {
		// needs ctx — see signature change below
	}
	// fallback: first mechanical candidate as before
	const first = buildCandidates(toolName, args)[0];
	if (first === undefined) {
		return "No rule can allow this call: the command uses shell control, which no remembered allow rule can suppress.";
	}
	return `To allow this call, add rule:\n${first.yaml}`;
}
```

Change the signature to `renderAllowSuggestion(toolName: string, args: unknown, ctx: EngineContext): string` and update its callers (the wrapper deny path). New body:

```ts
export function renderAllowSuggestion(toolName: string, args: unknown, ctx: EngineContext): string {
	const command = argString(args, "command");
	if (toolName === "bash" && command !== undefined && command.length > 0) {
		const override = denyOverrideSuggestion(command, ctx);
		if (override !== undefined) {
			const rule = { ...override.rule } as Omit<PermissionRule, "layer">;
			return (
				`This call is denied by ${overrideRuleId(command, ctx)}. To permit it, add this rule ` +
				`(more specific than the deny, class ${override.matchClass}):\n${renderCandidateYaml(rule)}`
			);
		}
		return "This call is denied, and no allow rule can override the matching deny. Add a more specific allow rule (same command shape, more literal tokens) via /permissions add, or change the deny.";
	}
	const first = buildCandidates(toolName, args)[0];
	if (first === undefined) {
		return "No rule can allow this call: the command uses shell control, which no remembered allow rule can suppress.";
	}
	return `To allow this call, add rule:\n${first.yaml}`;
}
```

Add a small helper `overrideRuleId(command, ctx)` returning the deciding deny's id (reuse `denyOverrideSuggestion`'s resolution: `resolveWholeCommandRule(...)?.rule.id ?? "a deny rule"`). Callers of `renderAllowSuggestion` (the bash tool wrapper deny path) pass `ctx` — find them with `grep renderAllowSuggestion` and update.

- [ ] **Step 5: Run tests and `bun check`**

Run: `bun test test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts` and `bun check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/permissions/engine.ts src/tools/permissions/prompt.ts test/tools/permissions/engine.test.ts test/tools/permissions/prompt.test.ts
git commit -m "feat(coding-agent): structured deny-error override suggestions"
```

---

### Task 8: `/permissions test` reports match class and specificity

Spec §8: dry-run output names the winning rule's match class and, for deny-vs-allow conflicts, which rule won and why.

**Files:**
- Modify: `packages/coding-agent/src/tools/permissions/manage.ts` (`testCommand`)
- Modify: `packages/coding-agent/src/prompts/tools/permissions.md` (model-facing doc: test output description)
- Test: `packages/coding-agent/test/tools/permissions/manage.test.ts`

**Interfaces:**
- Consumes: `evaluateBashCommand`, `resolveWholeCommandRule`, `matchClassOf`, `patternSpecificity`, `loadRuleLayers`.
- Produces: no new exports — extended `testCommand` output lines.

- [ ] **Step 1: Write the failing test**

```ts
// manage.test.ts
test("test output includes match class and specificity winner", async () => {
	// temp dynamic file: deny bash "* | head *", allow bash "git branch * | head *"
	// run the test subcommand for "git branch -a | head -20"
	// expect output to contain "decision: allow", "class: exact-structure", and the allow rule id
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test test/tools/permissions/manage.test.ts`
Expected: FAIL — output lacks class info.

- [ ] **Step 3: Extend `testCommand`**

After computing `decision`, resolve the deciding rule explicitly and annotate:

```ts
	const { rules } = loadRuleLayers(ctx.cwd);
	const best = resolveWholeCommandRule(rules, "bash", { command });
	const commandPattern = best?.rule.match.command;
	const matchClass =
		best !== undefined && typeof commandPattern === "string"
			? matchClassOf(commandPattern, command)
			: undefined;
	// ...existing lines...
	if (best !== undefined && matchClass !== undefined) {
		lines.push(`class: ${matchClass} (specificity ${patternSpecificity("command", String(commandPattern))})`);
	}
```

Also add the per-piece class summary when a deny-vs-allow conflict was resolved: if `best !== undefined`, push `resolved: ${best.rule.id} beats N other matches`. Keep the change minimal: class + specificity line plus the existing attribution lines.

- [ ] **Step 4: Update `permissions.md`**

Change the `test` bullet to: `dry-run a bash command against the permission engine and report the decision, the deciding rule id + layer, and the match class (exact-structure vs covering) plus specificity. Nothing is written.`

- [ ] **Step 5: Run tests and `bun check`**

Run: `bun test test/tools/permissions/manage.test.ts` and `bun check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/permissions/manage.ts src/prompts/tools/permissions.md test/tools/permissions/manage.test.ts
git commit -m "feat(coding-agent): permissions test reports match class and specificity"
```

---

### Task 9: Full-suite reconciliation and TUI smoke verification

Verifies the redesign end-to-end and updates package docs. Runs last, after all tasks.

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.md` (Unreleased → Changed/Added entries)
- Modify: `docs/superpowers/specs/2026-08-10-tool-permissions-design.md` (only if implementation diverges from spec — record the divergence)

- [ ] **Step 1: Run the full permission test suite**

Run: `bun test test/tools/permissions test/modes/components/permission-dialog.test.ts test/agent-session-acp-permission.test.ts`
Expected: PASS.

- [ ] **Step 2: Run `bun check` and the broader coding-agent suite**

Run: `bun check` then `bun test test/tools` (or the package's CI script per `package.json`).
Expected: PASS. Fix any cross-package fallout (extension type changes).

- [ ] **Step 3: TUI smoke via the omp-tmux-test workflow**

Use `~/.omp/agent/scripts/omp-tmux-test` (headless tmux) to drive the running fork build with `permissions.default: prompt` and verify against the preview mockups in `/tmp/permission-dialog-preview.sh`:

1. A compound command (`git log --oneline -3 && echo hi && git status --short | head -2`) with only an `echo *` dynamic rule → one dialog; verify: title `Approve this command?`, accent summary line `2 of 3 pieces need approval — no rule covers this command`, rows prefixed `&& `, ` |head`/` |head -2` dimmed, statuses `no rule` / `allowed · remembered this session`, four v3 actions, `esc cancel — no rule written` help.
2. Enter on a piece row → drill-down dialog with the four per-piece actions + Back.
3. `Allow all & remember…` → checklist with `[x] git log *` / `[x] git status *`, `space` toggles, `e` edits (input dialog), YAML preview box updates, `Write checked rules (2)`.
4. `Deny all & remember…` on the same command → writes `* | head *` deny for the pending pipe pieces; re-run the command → denied with no dialog; the model-visible error contains the override suggestion when a more-specific allow exists.
5. `/permissions test "git log --oneline -3 && echo hi && git status --short | head -2"` shows class/specificity lines.
6. `l` expands a truncated long command; color check: pending rows bold, allowed rows dim green.

Record the tmux transcript output as evidence in the task report.

- [ ] **Step 4: Changelog**

Add to `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- Permission rules resolve by match class and specificity: exact-structure beats covering, most specific wins, deny wins ties, curated hard-denies absolute (spec §3.1).
- Curated safe-consumer exemption: `git log *` covers `git log … | head -1`; exec-capable stages still require rules.
- Approval dialog v3: one compound dialog (piece list = command), per-piece drill-down, remember checklists with glob editing, deny-error override suggestions.

### Changed
- `Tool always` remember scope is offered only for read-only tools, never bash.
- `/permissions test` reports match class and specificity.
```

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/CHANGELOG.md docs/superpowers/specs/2026-08-10-tool-permissions-design.md
git commit -m "docs(coding-agent): v3 permission engine changelog and spec reconciliation"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 (precedence) → Task 1; §3.3 (layer tiebreak) → Task 1; §3.4/§4.3 (safe consumers) → Task 2; §4.3 (one dialog, drill-down) → Tasks 3/5; §5.1 (dialog v3) → Tasks 3–6; §5.2 (deny error) → Task 7; §5.3 (suggestions append) → unchanged flow, preserved in Tasks 5/6; §8 (`test` output) → Task 8; §11 (testing) → per-task tests + Task 9; §12 (out of scope) — no additions.
- **Deliberate divergences from the spec's numbering:** the legacy deny loop keeps its pre-curated position (Task 1 Step 5 comment) to preserve attribution; `e`-edit is delivered via the checklist's edit sentinel plus `ui.input`, not a component-level keybinding, because the dialog promise is data-only.
- **Type consistency:** `PermissionDialogLine`/`PermissionDialogOption` defined once in Task 3 and consumed by Tasks 4–6; `MatchClass`/`RuleMatch`/`resolveWholeCommandRule` defined in Task 1, consumed by Tasks 7–8; `rememberCompound(ui, pendingPieces, action, ctx)` signature fixed in Task 5 and implemented in Task 6.
