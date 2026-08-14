# Tool Permission System for Oh My Pi — Design

Date: 2026-08-10
Updated: 2026-08-13 — dialog redesign v3 (§5.1) · specificity precedence replacing deny-absolute (§3.1) · safe-consumer exemption (§3.4/§4.3) · deny-error suggestion (§5.2)
Status: Approved for spec review
Branch: `permissions-engine` (fork of `can1357/oh-my-pi`, based on `fork-17x`)

## 1. Summary and goals

Replace omp's approval subsystem with a single unified permission engine. The system:

- gates **every tool call** with a **deny-by-default posture** (curated read-only allowlist, everything else prompts until a rule exists);
- evaluates **rule layers**: dynamic ("approve and remember") > project (committed `.omp/permissions.yml`) > user (`~/.omp/agent/permissions.yml`) > curated code defaults;
- **splits compound bash commands** with a real shell parser and evaluates each piece separately;
- offers **rule candidates and LLM-suggested rules inside the approval dialog**;
- lets **headless subagents park pending approvals** and bubble a notice to the root session, where the user answers in the focused subagent view;
- writes an **audit log** and exposes a `/permissions` management surface.

Hard requirements from the user:

1. **One system, no overlapping layers.** The built-in gate, `tools.approval`, `bash.patterns`, and the binary prompt are *replaced*, not wrapped. A fork of omp is authorized for anything the extension API cannot do.
2. **Multi-command shell calls are split into separate commands before permission evaluation.**
3. **Subagents still prompt and wait**; a notice bubbles to the top session so the user can go answer in the subagent chat.

## 2. Current subsystem being replaced

Everything below is superseded by the engine (kept only where noted):

| Piece | Location (approx.) | Fate |
|---|---|---|
| `tools.approvalMode` (yolo/write/always-ask) | settings + `src/tools/approval.ts` | mapped onto `permissions.default` (see §9) |
| `tools.approval.<tool>` (allow/deny/prompt) | settings | legacy compat layer, shown in `/permissions list` as "legacy" |
| `bash.patterns` rules | settings + approval path | replaced by engine rules; migrate command rewrites |
| Critical destructive/remote-execute patterns | bash tool approval function | absorbed as curated hard-deny rules |
| Binary `uiContext.select(["Approve","Deny"])` prompt | `wrapper.ts` approval gate | replaced by the engine dialog (§5) |
| Fragment tokenizer (`&&`, `||`, `;`, `\|`, `&`, newlines) used for matching | `bash-interceptor.ts` + approval path | replaced by the brush parser (§4) |
| Headless fail-closed on prompt | `wrapper.ts` (`!hasUI()`) | kept only when no UI exists anywhere in the session chain (§6) |
| `bashInterceptor` (route `cat`→`read` etc.) | `src/tools/bash-interceptor.ts` | kept as routing; messages restyled to be distinct from permission denials |
| Tool tiers (`read`/`write`/`exec`) | `src/tools/approval.ts` | kept as internal annotation for curated defaults; not user-facing |

Behavior preserved as invariants: **deny wins ties** (a deny rule beats an allow rule of equal specificity; curated code-level hard-denies remain absolute — see §3.1); unknown/malformed input is treated as the strictest relevant case; handler/gate failures fail closed.

## 3. Engine architecture

### 3.1 Decision pipeline

For each tool call, the engine computes one decision in this order:

1. **Curated hard denies** — code-level critical patterns for bash (`CRITICAL_BASH_PATTERNS`: `rm -rf /` class, fork bombs, fetch-then-execute, `/etc/passwd`-class writes, shutdown). **Absolute**: no rule from any layer overrides them.
2. **Whole-command rule matches, resolved by match class then specificity** — merged dynamic → project → user rules evaluated on the piece text:
   - **Exact-structure match** — the rule's `command` pattern has the same pipeline shape as the piece (both contain a pipe, or neither does). Beats any covering match.
   - **Covering match** — a pipe-less pattern matching a piped command (the glob spans `| …`). Only stands when every non-safe stage passes (§4.3).
   - Within a class, **most specific wins** — specificity = literal-token count of the pattern (regex patterns score their literal prefix); ties resolve **deny wins**, then higher layer wins (dynamic → project → user).
3. **Stage-level rule matches** — rules matching an individual pipeline stage of an otherwise-covered piece (deny beats allow here).
4. **Curated safe-consumer exemption** — a pipeline stage that matches no rule is allowed when its first token is in the curated safe-consumer set (§4.3). Never beats a matching deny.
5. **Curated read-only allowlist** (allow, no prompt): read, glob, grep, todo, recall, permissions (management tool), and similar metadata-only tools.
6. **Default posture** — `permissions.default: allow | prompt | deny`. Default value: `prompt` (the user's deny-by-default choice). A "pending" decision means *prompt* in interactive contexts and *park* in headless contexts (§6).

This replaces the v1 invariant "deny is absolute (any layer)": a user-authored **more-specific** whole-command allow can now beat a **general** deny (e.g. `git branch * | head *` beats `* | head *`), which the deny-general/permit-specific workflow requires (§5.2). Curated hard denies stay unconditional. "Pending" is defined as: not allowed by any rule and not denied by any rule.

### 3.2 Rule model

YAML, one rule per list item. Example:

```yaml
rules:
  - id: git-read-only            # optional; auto-generated (slug + counter) if absent
    tool: bash
    match:
      command: "git *"           # bash: glob on the normalized command (single piece)
    action: allow                # allow | deny | prompt
    reason: "read-only git inspection"
    ttl: 600                     # optional seconds; expiry re-evaluated at match time
```

- `tool`: required. Tool name, or `*` for any tool.
- `match`: tool-specific matchers, all must match (AND):
  - bash: `command` (glob with `*`/`?`, or regex when wrapped in `/…/`).
  - file tools (read/write/edit/glob/grep/…): `path` glob (e.g. `src/**`), optional `pattern` for grep.
  - any tool: key/value pairs on the structured args — equality, or glob/regex when the value is a string starting with `*`/`/`.
- `action`: `allow` | `deny` | `prompt` (`prompt` = force the dialog even in an `allow` posture).
- `ttl`: optional seconds; expired rules are ignored at evaluation time and cleaned up on load.
- `id` must be unique within a file; duplicates fail validation of that file (file skipped with a warning).

### 3.3 Layers and precedence

| Layer | File | Owned by | Precedence |
|---|---|---|---|
| Dynamic | `~/.omp/agent/permissions.dynamic.yml` | engine (prompt "remember") | highest (most specific, most recent) |
| Project | `.omp/permissions.yml` (nearest project root) | repo (committed, shareable) | middle |
| User | `~/.omp/agent/permissions.yml` | user (hand-edited) | lower |
| Curated | code constants | engine | lowest |

- Deny and allow rules from all layers participate in the §3.1 resolution: match class first (exact-structure > covering > stage-level), then specificity (literal-token count), then **deny wins ties**, then layer order (dynamic → project → user). Curated code-level hard denies are absolute (step 1, §3.1).
- All layers merge into one evaluated list; `/permissions list` shows the merged view with layer tags.
- Dynamic file is app-owned: rewritten atomically on change; deleting it resets remembered rules. Never mutates user/project files.

### 3.4 Curated defaults (code-level)

- **Read-only allowlist** (allow, no prompt): read, glob, grep, todo, recall, permissions (management tool), and similar metadata-only tools. Reviewed and pinned in code.
- **Hard-deny prelude** (bash): the existing critical patterns — `rm -rf /` (and `rm` on root/FHS critical paths), fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`-class files, host shutdown commands. Plus the current "allow rules never permit shell-control syntax" behavior becomes unnecessary (§4: per-piece matching means rules match single commands).
- **Safe-consumer set** (bash pipeline stages): `head`, `tail`, `grep`/`egrep`, `wc`, `sort`, `uniq`, `tr`, `cut`, `cat`, `nl`, `tac`, `rev`, `paste`, `join`, `column`, `fmt`, `fold`, `pr`, `comm`, `diff`, `cmp`, `jq`, `less`, `more`, `md5sum`/`sha*sum` digests. Excluded by design: `sed` (`-i` writes), `awk` (`system()`), `xargs` (executes), `perl`/`python`/`node`-class interpreters, and any `-c`/`-e`/`-Command` reinterpreting option. See §4.3.

### 3.5 Settings schema

```yaml
permissions:
  default: prompt            # allow | prompt | deny
  llmSuggestions: true       # §5.3
  audit:
    enabled: true
    maxEntries: 10000        # rotation
  # subagentDefault deliberately absent in v1 (see §12)
```

## 4. Bash command splitting

### 4.1 Parser

- Expose the **brush parser** (vendored `brush-core`, the shell engine that executes non-PTY bash tool calls) through a `pi-natives` binding: `parseShellCommand(command: string) → { ok: true, ast: … } | { ok: false, error }`, AST serialized as JSON (or a compact node list).
- Rust side: new module in `crates/pi-natives` (or `crates/pi-shell` re-export) + generated declarations + `index.d.ts` types. Output is a compact node list (`{ type, text, children, operator? }`), JS-side friendly. Pure parse; no expansion, no execution.
- **Fail-closed parsing:** if the parser returns an error or the engine cannot map the AST confidently, the command is treated as one unit, and the strictest applicable decision among all rules/pattern matches applies. Never under-analyze. (A brush parse error means the shell would reject the command anyway → deny with the parser reason.)

### 4.2 Split semantics

- **Split points (top level):** `;`, newlines, `&&`, `||`, `&`. Each produces a **piece** with its control operator recorded.
- **Pipelines** (`a | b`, `a |& b`) stay whole as one piece.
- **Nested constructs** — `$( )`, backticks, heredocs, `if/while/until/case/for`, subshells `( )`, brace groups `{ }` — are parsed recursively and analyzed *within* their containing piece, never split out. A deny inside a nested construct denies the containing piece.
- `cd x && cmd` (leading single-line cd) is normalized into `cwd` by the existing bash tool input handling *before* the engine evaluates — the engine evaluates the post-normalization command (what actually executes). The cwd normalization is unchanged.
- Variable/expansion-dependent content (`$HOME`, `$(…)` output) is matched **literally** against rules — best-effort; documented limitation. The literal text of nested commands is what rules see.

### 4.3 Evaluation and execution

- Each piece is evaluated independently against the pipeline (§3.1).
- **Any piece denied → the whole call is denied.** The model-visible error names the piece, the rule id, and the layer.
- **Pending pieces → one dialog** showing the full command breakdown (§5.1); a per-piece drill-down is available for granular decisions. After all pending pieces are resolved, decisions are final.
- **If every piece is allowed → execute the original command unchanged.** No rewriting, no re-issue; `&&`/`||` short-circuit and `&` semantics are preserved by construction, and the result is identical to running the approved pieces separately in the same persistent shell.
- **Pipeline stages — safe-consumer exemption.** `evaluateBashPiece` recursively evaluates every stage of an allowed pipeline piece (current behavior). A stage that matches **no rule** (no deny, no allow) is allowed when its first token is in the curated safe-consumer set (§3.4). The exemption only fills the "no rule" gap — a matching deny always beats it, and a stage-level allow beats the exemption. Effect: one rule such as `git log *` covers both `git log -n 5` and `git log -n 5 | head -1`; `sh`/`xargs`/`sed`-class stages still require an explicit rule, so `curl * | sh`-style combinations cannot slip through a first-command allow (the `sh` stage is neither safe nor matched → prompt/deny).
- **PTY carve-out:** `pty: true` calls (interactive sessions) cannot be execution-split or piece-dialoged. Whole-command analysis applies: the strictest piece decision decides the call (deny → deny; pending → one whole-command dialog).

## 5. Approval prompt UX

### 5.1 Dialog structure (one dialog per call, v3)

One dialog per compound command, showing the full breakdown. **The piece list is the command**: each top-level unit (split per §4.2) on its own line, prefixed by its operator (`&&`, `||`, `;`) on continuation lines, so reading down reconstructs the original command — no separate elided copy, no duplication. Layout:

- **Title**: `Approve this command?` — the question is about the command, not the tool; the tool name is right-aligned metadata. (Never "Allow tool: bash": that reads as a blanket grant and collides with the remember scopes.)
- **Summary line** (one, highlighted): `N of M pieces need approval — no rule covers this command`. This replaces the old "no rule — default posture" line, which contradicted the per-piece statuses beside it.
- **Piece rows**: unnumbered (the old 1–5 numbering collided with the action numbering), status right-aligned:
  - `no rule` — pending, needs the decision (bold row)
  - `allowed · remembered this session` — covered by a rule (dim green row; "this session" not "dynamic")
  - Safe-consumer pipe tails render **dimmed** (`git log …` normal, ` |head -60` gray): they are exempt (§4.3) and not the thing being decided.
- **Near-miss line** under a pending piece only when genuinely close: same first token as the piece and a narrower glob (e.g. rule `git branch -a *` vs piece `git branch -b x`). Unrelated rules (`echo *` vs `git branch`) are never shown.
- **Suggestion row** (§5.3) with spinner while pending; resolved suggestions append as extra numbered options with YAML previews; late results are dropped.
- **Actions** (numbered):
  - `1. Allow all pending once`
  - `2. Allow all & remember…`
  - `3. Deny all pending`
  - `4. Decide per piece →` (drill-down)
  - Suggested rules append as `5.`+ options.
  - No preselection on this dialog — the allow/deny choice is deliberate. `esc` = cancel, no rule written.
- **Per-piece drill-down** (option 4, or Enter on a piece row): piece text + status, then `Allow once` / `Allow & remember…` / `Deny once` / `Deny & remember…` / `Back to all pieces`.
- Keys: `j/k` navigate, `enter` select, `esc` cancel/back, `l` expand a truncated command, in remember dialogs `space` toggles checklist items and `e` edits a glob.

**Remember sub-dialogs** (both `Allow & remember…` and `Deny & remember…`; deny variant writes deny patterns):

- **Compound** — per-piece checklist: one row per pending piece, `[x] <first-token glob>` with the piece text alongside; all checked and **preselected** (Enter writes immediately); `space` toggles a piece, `e` edits its glob. The exact-match scope is not offered and the dialog says why: *an exact match would never fire again for a compound*. The YAML preview updates live; the write button reads `Write checked rules (N)`.
- **Single piece** — scope options with YAML preview:
  - `Exact call` — the precise command/args as executed
  - `Pattern` — bash: first-token glob (`git branch *`); file tools: path glob of the parent directory (`src/**`). **Preselected.**
  - `Custom…` — edit the glob (the disagreement escape: narrower or wider than the first-token pattern)
  - `Tool always` — **offered only for read-only tools** (read, glob, grep, …; curated per-tool flag). Never for bash or any exec/write-capable tool: a tool-wide bash allow is the yolo knob and is not offered by the dialog (hand-editable in the permissions file only).
- Each option previews the exact YAML it writes. Picking a remember option writes the dynamic rule(s) and proceeds.

The dialog shows the decision context per piece: matched rule id + layer, or `no rule`, plus the `reason` when one exists.

### 5.2 Denied calls

Denied calls **never open a dialog** — that is the point of a deny (no interruption). The model-visible error shows the blocking rule id + layer + reason, and — when a more-specific whole-command allow would beat the denying rule (§3.1) — a **structured suggestion**: the exact YAML and why it wins (e.g. "`git branch * | head *` is more specific than `* | head *`"). The user applies it via `/permissions add` and verifies with `/permissions test "<command>"`, which reports the winning rule and its match class. No interactive override exists; a deny stays fail-closed until policy changes. The model-facing error explains both paths (`/permissions add` or ask the user).

### 5.3 LLM-suggested rules (async append)

- When a piece is pending, the engine fires a **side completion request** on the session's active model (one-shot, non-streaming, short timeout, low token budget) with: the pending piece, the session cwd, a summary of currently applicable rules, and an output schema constraining suggestions to valid rule YAML (allow/deny only, `tool`/`match`/`action`/`reason`).
- The dialog appears **immediately** with the mechanical candidates (§5.1 scope options); LLM suggestions stream in behind a small spinner and **append as extra options** when ready. Suggestions that arrive after the user chose are dropped.
- Failure/timeout of the side request degrades silently to candidates-only.
- Controlled by `permissions.llmSuggestions` (default on).
- LLM-suggested rules are never auto-applied; they are options the user explicitly picks.

## 6. Subagent approval (park and bubble)

### 6.1 Flow

1. A subagent tool call resolves to **pending** and the subagent has no UI context (verified: subagent runners initialize with `noOpUIContext`).
2. The call **parks**: the engine blocks on a promise, keyed by `(sessionId, toolCallId)` in a process-local pending registry.
3. A **notice bubbles to the root session**: root UI notification ("Subagent `foo` is waiting for approval: `<command>`") + a `permission-pending` entry in the subagent's transcript + an ⏳ marker on the Agent Hub roster row.
4. The user focuses the subagent (Agent Hub → Enter). The focused view renders the **same approval dialog** (§5): piece status, candidates, async LLM suggestions, deny/allow scopes.
5. The user's choice resolves the parked call through the engine: allow → the call proceeds; deny → the call fails with the standard deny error.

### 6.2 Semantics

- Notices always bubble to the root session; answers route down the session tree to the parked call (subagents may nest).
- Waiting is indefinite until answered or the agent is aborted/killed (Esc in focused view, Hub `x`, parent abort).
- If **no UI exists anywhere in the chain** (print mode, RPC, ACP), pending fails closed with the existing "requires approval but no interactive UI available" error.

### 6.3 Implementation notes

- Engine-side parked-promise registry + a `permission-pending` custom entry type with a focused-view renderer and key/input handling (mirrors the existing approval dialog component).
- Root notification via the root session's UI context; roster marker via the agent registry's progress/status events.
- Timeout/abort paths must resolve or reject all parked promises owned by an aborted session (no leaks).

## 7. Audit log

- Append-only JSONL at `.omp/permissions-audit.jsonl` (project-scoped; gitignored by default).
- One record per call, appended when the decision is final: denied/blocked calls at gate time; allowed calls after execution (so `outcome` is present). Record fields: `ts`, `sessionId`, `agent` (subagent name when applicable), `tool`, `command`/`args`, `decision` (`allow`/`deny`/`prompt`/`park`), `ruleId`, `layer`, `reason`, `pieces` (bash: per-piece decisions), `outcome` (`executed`/`blocked`/`error`).
- Rotation: keep newest `permissions.audit.maxEntries` (default 10000) entries; truncate on load.
- Visible via `/permissions log`. Full commands are recorded (same sensitivity as the session transcript).

## 8. Management surface

- `/permissions` slash command (interactive + usable by the model through the `permissions` tool where sensible):
  - `list` — merged rules by layer with match counts
  - `show <id>` — rule details + last hits
  - `add | remove | edit` — with TTL support here (not in the prompt)
  - `test "<command or tool call>"` — dry-run: exactly which rule/layer decides and why, including the match class (exact-structure / covering / stage-level) and, when specificity resolved a deny-vs-allow conflict, which rule won and why
  - `log` — recent audit entries
  - `status` — posture, layer counts, dynamic-file path
  - `migrate` — §9
- One read-only model-facing tool `permissions` (list/test only; editing stays with the user). It is in the curated allowlist, so it never prompts.

## 9. Config integration and migration

### 9.1 In-memory compat (first run, automatic)

Legacy keys continue to work without rewriting user files, mapped into the engine:

| Legacy | Mapping |
|---|---|
| `tools.approvalMode: yolo` | `permissions.default: allow` |
| `tools.approvalMode: write` | `permissions.default: prompt` (slightly stricter for write-tier tools; migrate suggests `tool: write → allow` style rules to restore) |
| `tools.approvalMode: always-ask` | `permissions.default: prompt` |
| `tools.approval.<tool>: allow\|deny\|prompt` | legacy layer rules (deny wins ties under §3.1) |
| `bash.patterns` (match/approval) | engine rules (deny/prompt/allow per pattern) |

A one-time notice lists the mapping that applies to the current config.

### 9.2 `/permissions migrate`

Rewrites config: legacy keys → equivalent `permissions.yml` rules, removes the legacy keys from `config.yml`, writes the new `permissions` block. Dry-run mode first. Idempotent; refuses to run with uncommitted hand-edits to `permissions.yml`.

## 10. Module layout and integration points (fork)

```
packages/coding-agent/src/tools/permissions/
  engine.ts        # decision pipeline (§3.1)
  rules.ts         # layer loading, YAML parse/validate, dynamic store
  parser.ts        # natives parseShellCommand wrapper + fail-closed fallback
  split.ts         # AST → pieces (top-level split; nested analysis)
  prompt.ts        # dialog flow, candidates, scopes, YAML preview
  suggest.ts       # LLM side-completion suggestions (§5.3)
  subagent.ts      # parked approvals, bubble/route, pending registry
  audit.ts         # JSONL writer + rotation
  manage.ts        # /permissions command + permissions tool
  migrate.ts       # legacy mapping + rewrite
```

Integration points (all in `packages/coding-agent`):

1. **Gate**: the wrapper approval path calls the engine instead of `resolveApproval` (`src/extensibility/extensions/wrapper.ts`).
2. **Bash tool**: the engine evaluates the post-normalization command; split plan feeds the gate and dialogs (`src/tools/bash.ts`).
3. **Prompt call site**: replace the binary `uiContext.select` with the engine dialog (§5).
4. **Settings schema**: add `permissions.*`; keep legacy keys readable for compat.
5. **Natives**: `parseShellCommand` binding (Rust + declarations + JS wrapper + tests) in `packages/natives` / `crates/pi-natives` (+ `crates/pi-shell` if the parser lives there).
6. **TUI**: `permission-pending` entry renderer + focused-view dialog (`src/modes/...`); Agent Hub roster marker.
7. **Session tree**: bubble/route wiring for subagent approvals (root discovery + parent chain).

Branch: `permissions-engine` off `fork-17x`. Build/run from source (the fork already builds: `node_modules` + `dist/cli.js` present). Swapping the global bun install to the fork build is a deployment step handled at implementation time (documented in the plan).

## 11. Testing strategy

- **Unit**: rule parse/validate (bad files skipped, duplicate ids), precedence matrix (curated hard-deny absolute; exact-structure beats covering; specificity ties → deny; stage-level deny beats covering allow; safe-consumer exemption applies only with no matching rule; safe set excludes `sed`/`awk`/`xargs`/interpreter flags), split fixtures (compounds, heredocs, `$()`, pipelines, `&`, `if/while`, malformed input → fail-closed), TTL expiry, audit rotation, migrate mapping both ways.
- **Integration**: engine decision against the wrapper gate (existing tool-test harness); dialog flow via the omp TUI headless test workflow (tmux) — checklist toggle/edit, preselect, drill-down, dimmed safe-consumer tails, late-suggestion drop; deny-error structured suggestion rendering; subagent park/bubble with a nested two-session fixture; `/permissions` command tests.
- **Manual checklist**: no double prompts with `permissions.default: prompt`; legacy `yolo` behaves as `allow`; `write` mode notice appears; subagent pending notice + focused answer round-trip; PTY call gets whole-command analysis.

## 12. Out of scope (v1)

- `permissions.subagentDefault` knob (noted in §3.5; one-line follow-up if subagent friction is real).
- Per-session grant inheritance from parent approvals.
- Approval-history UI beyond `/permissions log`.
- Marketplace/plugin distribution of the engine (it is core).
- ACP permission-gate changes.
- Multi-user/shared policy servers; rule-template libraries.

## 13. Risks and open items

- **Brush parse binding**: scope is parse-only (no expansion, no execution). Expansion-dependent matching is literal best-effort (documented limitation).
- **LLM suggestion cost/latency**: bounded by timeout + token budget; degrades to candidates-only; user-toggleable.
- **Focused-subagent input affordance**: exact key/input mechanics for the dialog in a focused subagent view to be verified during implementation (TUI internals); the Agent Hub roster marker is a small add-on and can slip to a follow-up.
- **Rebase strategy**: engine is a bounded module + discrete callsites; fork rebases onto upstream stay mechanical.
- **Specificity scoring**: literal-token counting is a heuristic; regex patterns score their literal prefix. Ambiguous comparisons resolve conservatively (deny wins ties); `/permissions test` reports the winning rule and its class so surprising outcomes are explainable.
- **`write` mode users**: slightly stricter than before by design (deny-by-default); migrate notice explains restoration rules.
