# Tool Permission System for Oh My Pi — Design

Date: 2026-08-10
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

Behavior preserved as invariants: **deny is absolute** (a deny from any layer beats every allow); unknown/malformed input is treated as the strictest relevant case; handler/gate failures fail closed.

## 3. Engine architecture

### 3.1 Decision pipeline

For each tool call, the engine computes one decision in this order:

1. **Hard denies** — curated critical-pattern rules (bash) and any rule with `action: deny` from any layer. Deny short-circuits with the rule's id + reason.
2. **Ordered rules, first match wins** — merged list ordered: dynamic → project → user → curated. Only rules that are not deny rules reach this stage (denies already short-circuited).
3. **Default posture** — `permissions.default: allow | prompt | deny`. Default value: `prompt` (the user's deny-by-default choice). A "pending" decision means *prompt* in interactive contexts and *park* in headless contexts (§6).

"Pending" is defined as: not allowed by any rule and not denied by any rule.

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

- Deny rules from *any* layer beat every allow rule (invariant).
- Among non-denies, first match wins in the order above (dynamic → project → user → curated).
- All layers merge into one evaluated list; `/permissions list` shows the merged view with layer tags.
- Dynamic file is app-owned: rewritten atomically on change; deleting it resets remembered rules. Never mutates user/project files.

### 3.4 Curated defaults (code-level)

- **Read-only allowlist** (allow, no prompt): read, glob, grep, todo, recall, permissions (management tool), and similar metadata-only tools. Reviewed and pinned in code.
- **Hard-deny prelude** (bash): the existing critical patterns — `rm -rf /` (and `rm` on root/FHS critical paths), fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`-class files, host shutdown commands. Plus the current "allow rules never permit shell-control syntax" behavior becomes unnecessary (§4: per-piece matching means rules match single commands).

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
- **Pending pieces → sequential per-piece dialogs**, one at a time, in command order (§5). After all pending pieces are resolved, decisions are final.
- **If every piece is allowed → execute the original command unchanged.** No rewriting, no re-issue; `&&`/`||` short-circuit and `&` semantics are preserved by construction, and the result is identical to running the approved pieces separately in the same persistent shell.
- **PTY carve-out:** `pty: true` calls (interactive sessions) cannot be execution-split or piece-dialoged. Whole-command analysis applies: the strictest piece decision decides the call (deny → deny; pending → one whole-command dialog).

## 5. Approval prompt UX

### 5.1 Dialog structure (per pending piece, sequential)

Level 1 — main choice:

- `Allow once`
- `Allow & remember…`
- `Deny`
- `Deny & remember…`

Level 2 — scope (only when remembering):

- `Exact call` — the precise command/args as executed
- `Pattern` — bash: first-token glob (`git *`); file tools: path glob of the parent directory (`src/**`)
- `This tool always`

Each option previews the exact YAML it writes. Picking a remember option writes a dynamic rule and proceeds.

The dialog shows the decision context: matched rule id + layer, or "no rule — default posture", plus the `reason`, and for bash the full piece breakdown with per-piece statuses.

### 5.2 Denied calls

A deny shows the blocking rule and reason only — **no allow candidates** (deny is absolute). The model-visible error includes the exact YAML that would allow the call, so the model can negotiate in chat. The model-facing error also explains how to add the rule (`/permissions add` or ask the user).

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
  - `test "<command or tool call>"` — dry-run: exactly which rule/layer decides and why
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
| `tools.approval.<tool>: allow\|deny\|prompt` | legacy layer rules (deny still absolute) |
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

- **Unit**: rule parse/validate (bad files skipped, duplicate ids), precedence matrix (deny-absolute vs first-match across layers), split fixtures (compounds, heredocs, `$()`, pipelines, `&`, `if/while`, malformed input → fail-closed), TTL expiry, audit rotation, migrate mapping both ways.
- **Integration**: engine decision against the wrapper gate (existing tool-test harness); dialog flow via the omp TUI headless test workflow (tmux); subagent park/bubble with a nested two-session fixture; `/permissions` command tests.
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
- **`write` mode users**: slightly stricter than before by design (deny-by-default); migrate notice explains restoration rules.
