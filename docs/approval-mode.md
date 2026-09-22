# Tool permissions and approval mode

Every tool call passes through a single permission engine that decides `allow`, `deny`, or `prompt` before execution. The engine is deny-by-default: a curated set of read-only tools is allowed without prompting, and every other call prompts until a permission rule exists. Prompting means an interactive approval dialog in TUI sessions, and a parked-approval flow for headless subagents (below).

This page covers the engine's posture, rule files, bash command splitting, the approval dialog, subagent approvals, the audit log, the `/permissions` management surface, and how legacy `tools.approval*` settings map onto the engine.

## Posture

The default posture is configured with `permissions.default` (`allow | prompt | deny`, default `prompt`):

| Posture  | Effect |
| -------- | ------ |
| `prompt` | Prompt for any call not allowed by a rule (the deny-by-default default). |
| `allow`  | Auto-approve every call the engine does not deny. |
| `deny`   | Block any call not allowed by a rule. |

Resolution order: an explicitly configured `permissions.default` wins. Otherwise a legacy `tools.approvalMode` the user actually configured maps onto a posture (`yolo` → `allow`, `write`/`always-ask` → `prompt`). Otherwise the engine's default `prompt`. The legacy mode's own schema default (`yolo`) is ignored for posture — only an explicit configuration counts. `--auto-approve` / `--yolo` surface the legacy `yolo` mode so the posture resolves to `allow` (an explicitly configured `permissions.default` still wins).

A `deny` from any source is absolute and beats every `allow`. The `prompt` posture only asks; it never blocks.

## Decision pipeline

For each tool call the engine computes one decision in this order; the first decisive step wins:

1. **Tool-declared deny** — a tool's own approval declaration returning `deny`.
2. **Legacy user-policy deny** — `tools.approval.<tool>: deny`.
3. **Legacy `bash.patterns` deny** — evaluated before the curated deny so user-configured denies surface their own rule ids.
4. **Curated deny** — the bundled critical bash patterns (below).
5. **File-backed rule deny** — dynamic → project → user order.
6. **Tool-declared `prompt` / `override: true`** — e.g. the `ssh://` remote-target gates on `read`/`grep`/`write`, which prompt in every posture, including `allow`.
7. **Legacy user-policy prompt** — `tools.approval.<tool>: prompt`.
8. **Legacy user-policy allow** — `tools.approval.<tool>: allow`.
9. **First-match non-deny rule** — legacy allow patterns (single-piece commands only), then file-backed rules (dynamic → project → user). An `allow` rule that matches a bash command carrying shell-control syntax (pipelines, substitutions, redirects, `-c`/`-e` reinterpreting options) degrades to a prompt instead — allow rules never vouch for a command that can smuggle a second command.
10. **Curated read-only allowlist** — the tools below are allowed without prompting under every posture.
11. **Default posture** — `permissions.default` (or the legacy-mode mapping).

## Curated defaults

**Read-only allowlist** (allowed, no prompt): `read`, `glob`, `grep`, `todo`, `recall`, `reflect`, `web_search`, `ast_grep`, `ask`, `permissions`. Each entry is read-only or metadata-only, or inherently interactive (`ask` prompts the user; `permissions` is a read-only `list`/`test` surface whose schema rejects mutation actions). Mutating tools (`bash`, `write`, `edit`, `eval`, …) never ride the allowlist.

**Hard-deny prelude** (bash): the bundled critical patterns deny the whole call with a `curated` reason — recursive destruction (`rm -rf /`, `sudo rm`, `chmod -R … /`, `chown -R … /`), fork bombs, disk/filesystem destruction (`> /dev/sd*`, `mkfs`, `dd … of=/dev/`, `shred /dev/`, `cryptsetup`), writes to `/etc/passwd`-class files, remote-fetch-then-execute (`curl | sh`, `bash <(curl …)`, `eval "$(curl …)"`), `kill -9 1`, host shutdown commands, and `nc -e`/`nc -c` shells. The patterns also match against the raw command before splitting, so tokenizer-normalized shapes cannot evade them. Deny is absolute: no rule, posture, or mode can allow these.

## Rule files

Rules live in YAML files organized in layers, highest precedence first:

| Layer | File | Owned by |
| ----- | ---- | -------- |
| Dynamic | `~/.omp/agent/permissions.dynamic.yml` | engine ("allow & remember" writes); rewritten atomically; deleting it resets remembered rules |
| Project | `.omp/permissions.yml` at the nearest ancestor containing one (fallback: cwd) | repo (committed, shareable) |
| User | `~/.omp/agent/permissions.yml` | user (hand-edited) |
| Curated | code constants | engine (lowest) |
| Legacy | migrated settings keys (`tools.approval.*`, `bash.patterns`) | not file-backed; see [Legacy settings](#legacy-settings-and-migration) |

For MCP tools, key the policy by the exact final registered name. The ordinary form is
`mcp__<sanitized_server>_<sanitized_tool>`. A redundant `<server>_` prefix is removed from the tool name,
so server `echo` tool `echo_it` is registered as `mcp__echo_it`. Names longer than 64 characters are
capped with a deterministic hash suffix; use the final capped name rather than the uncapped pattern. See
[MCP tool naming](./mcp-server-tool-authoring.md#naming-and-collision-domain).

Deny rules from any layer beat every allow. Among non-denies, first match wins in the order dynamic → project → user → curated. `/permissions list` shows the three file-backed layers only (curated and legacy policy are surfaced through `/permissions test` and `/permissions migrate`).

Rule shape:

```yaml
rules:
  - id: git-read-only            # optional; auto-generated if absent
    tool: bash                   # tool name, or * for any tool
    match:
      command: "git *"           # bash: glob on the normalized command; /regex/ when wrapped in slashes
    action: allow                # allow | deny | prompt
    reason: "read-only git inspection"
    ttl: 600                     # optional seconds; expired rules are dropped at load
```

- `match` entries must all hold (AND). For bash, `command` globs (whitespace-normalized, `*` wildcards) or regexes (`/…/`). For file tools, `path` globs. For any tool, key/value pairs on the structured args — equality, or glob/regex for string values.
- `action: prompt` forces the dialog even in an `allow` posture.
- `tool: "*"` matches any tool; a single-entry match whose value is exactly `*` (e.g. `{ arg: "*" }`) always matches.
- Invalid or duplicate-id rules are skipped with load errors; a malformed file contributes no rules. An invalid regex never matches (warned once per process).

Remembered rules ("Allow & remember…" / "Deny & remember…") are written to the dynamic layer with deterministic `remember-*` ids, so re-remembering the same scope replaces the old rule. Remembered rules are per-user, never committed to the project.

## Bash command splitting

Before evaluation, a bash command is parsed with the shell parser (a `pi-natives` binding of the brush parser — pure parse, no expansion or execution) and split into **pieces**:

- Split points at the top level: `;`, newlines, `&&`, `||`, `&`.
- **Pipelines** (`a | b`, `a |& b`) stay whole as one piece.
- **Nested constructs** — `$(…)`, backticks, heredocs, `if`/`while`/`until`/`case`/`for`, subshells `( )`, brace groups `{ }` — stay inside their containing piece and are analyzed as part of it. A deny inside a nested construct denies the containing piece.
- **Fail-closed parsing**: a parse error or an unrecognized node kind collapses the whole command into one piece, and the strictest applicable decision applies. A brush parse error means the shell would reject the command anyway.
- Expansion-dependent content (`$HOME`, `$(…)` output) is matched literally against rules — best-effort, documented limitation.

Each piece is evaluated independently through the full pipeline:

- **Any piece denied → the whole call is denied.** The model-visible error names the piece, the rule id, and the layer.
- **Pending pieces → sequential per-piece dialogs** in command order (see below).
- **Every piece allowed → the original command executes unchanged** — no rewriting, no re-issue; `&&`/`||` short-circuit and `&` semantics are preserved by construction.

**Literal `&&` chains** (`bash.allowCompoundCommands`, default off): when enabled on a POSIX shell, a flat chain joined only by `&&` whose segments are literal arguments is evaluated per segment — allow rules may vouch for individual segments. Deny/prompt rules matching the complete chain but no individual segment remain whole-chain vetoes (a later veto deny overrides an earlier veto prompt). Critical shapes still prompt with override instead of allowing. A chain with any unmatched segment keeps the standalone `exec` tier with no explicit policy, so the tool-wide policy and mode decide. Anything else (expansion, globbing, redirection, other operators, stateful builtins, non-POSIX shells) keeps the per-piece behavior above.

A leading `cd <path> && …` wrapper is folded into the tool's `cwd` at execution time (single-line, no shell expansion). The engine evaluates the command as submitted, and the splitter treats `cd …` as its own piece, so navigation rules and the follow-up command are checked separately.

This pattern policy controls approval for the `bash` tool; it is not process or filesystem containment. An approved command retains the shell's ambient filesystem, network, and subprocess access. The `eval` tool also declares the `exec` tier and can spawn a shell via subprocess, so a `bash.patterns` `deny` rule does not apply to the same command run through `eval` — under `yolo`, that `exec` call resolves to `allow`. To gate the shell `eval` can reach, add a `tools.approval.eval` policy (`prompt` or `deny`) alongside `bash.patterns`.

**PTY carve-out**: `pty: true` calls (interactive sessions) cannot be split or piece-dialoged. The whole command is analyzed as one unit — the strictest piece decision decides the call (deny → deny; pending → one whole-command dialog), with candidates scoped to the whole command text.

## Approval dialog

For a pending call (interactive session), the dialog replaces the old binary Approve/Deny prompt:

- **Level 1** — per pending piece, sequentially in command order: `Allow once`, `Allow & remember…`, `Deny`, `Deny & remember…`.
- **Level 2** (when remembering) — the rule scope:
  - `Exact` — the precise command/args as executed;
  - `Pattern` — bash: first-token glob (`git *`); file tools: parent-directory glob (`src/**`);
  - `Tool` — this tool always (`{ arg: "*" }`).
- Every candidate previews the exact YAML it writes; picking one writes a dynamic rule and proceeds.
- The dialog shows the decision context: the matched rule id + layer (or "no rule — default posture"), the reason, and for bash the per-piece breakdown with statuses.
- **Cancelling the dialog denies.**
- Deny candidates are offered only while a piece is *pending* — never for hard-denied calls.

**LLM-suggested rules** (optional, `permissions.llmSuggestions`, default on): while a piece is pending, the dialog fires a one-shot side completion on the session's active model (8s timeout, 256-token budget, at most 3 rules) with the pending piece, the cwd, and a summary of current rules. The dialog appears immediately with the mechanical candidates; suggestions append as extra options behind a spinner. Suggestions arriving after the user chose are dropped; any failure (no model, no key, provider error, timeout, unparseable output) degrades silently to candidates-only. Suggested rules are never auto-applied — they are options the user explicitly picks.

## Computer tier

The disabled-by-default Eval [`computer` API](./computer-use.md) chooses its tier per call:

- direct helpers (`computer.windows()`, `win.screenshot()`, `win.ax()`, `el.bounds()`, `computer.clipboard.read()`, …) use `read` when the invoked method is inspection-only and `exec` for input, focus, mutation, and `clipboard.write`; read calls also run under the worker's read-only guard;
- `computer.run(fnOrCode, options)` uses `read` only for `read_only: true` (JavaScript trailing option or Python keyword); `read_only: false`, a missing field, malformed arguments, or any other value uses `exec`.

The approval prompt shows `read-only` when applicable, followed by the resolved JavaScript (truncated to 2,000 characters by the standard formatter). For `computer.run`, `read_only` is a trust declaration enforced by the approval tier, not static analysis of the script.

Separately, provider-originated computer-use calls may carry `pendingSafetyChecks` metadata. Any pending check forces an interactive prompt regardless of yolo or per-tool `allow`: the dialog offers only `Approve`/`Deny` with no rule candidates, in every posture. The prompt lists each safety-check code, message, and sanitized/truncated data. Without an interactive UI, the call fails closed with `pending provider safety checks but no interactive UI is available`.

## Denied calls

A hard deny (curated, rule, or tool-declared) shows the blocking rule and reason only — no allow candidates, because deny is absolute. The model-visible error names the rule and layer. A deny from the default posture (`permissions.default: deny`) additionally includes the exact allow-rule YAML for the call, so the model can negotiate in chat (a dynamic allow rule can unblock a posture deny; a rule cannot unblock a curated/tool/user deny). A legacy user-policy deny names the settings key to remove.

## Subagent approvals (park and bubble)

Subagents run headless, so a pending call cannot show a dialog in place:

1. The call **parks** on a promise, keyed by `(session, toolCallId)` in a process-local pending registry.
2. A **notice bubbles to the root session**: a root notification ("Subagent `foo` is waiting for approval: `<command>`"), a `permission-pending` entry in the subagent's transcript, and an awaiting-approval marker on the Agent Hub roster row.
3. The user **focuses the subagent** (Agent Hub → Enter). The focused view renders the same approval dialog — piece status, candidates, async LLM suggestions (on the parked session's model), deny/allow scopes.
4. The user's choice **resolves the parked call**: allow → the call proceeds; deny → the call fails with the standard denied error. Remember options write dynamic rules as usual.

Waiting is indefinite until answered or the agent is aborted. Aborting/killing the agent rejects every parked promise it owns (no hangs, no leaks). If no UI exists anywhere in the session chain (print mode, RPC, ACP), a pending call fails closed with the legacy "requires approval but no interactive UI available" error, preserving non-interactive behavior.

## Audit log

Every final engine decision is appended as one JSONL record to `.omp/permissions-audit.jsonl` in the session's project directory (gitignored). Records are written at the final decision point: gate-time denies with `outcome: "blocked"`, allowed calls after execution with `outcome: "executed"`. Fields: `ts`, `sessionId`, `agent`, `tool`, `command`/`args`, `decision`, `ruleId`, `layer`, `reason`, `pieces`, `outcome`. The file rotates to the newest `permissions.audit.maxEntries` records (default 10000). Full commands are recorded — same sensitivity as the session transcript. Audit failures are silent (the tool call never breaks); `permissions.audit.enabled: false` disables recording. Browse via `/permissions log`.

## The `/permissions` surface

`/permissions <subcommand>` (also available to the model through the read-only `permissions` tool for `list`/`test`):

| Subcommand | Effect |
| ---------- | ------ |
| `list` | Merged file-backed rules by layer (dynamic → project → user) with audit match counts. |
| `show <id>` | Rule details plus its last audit hits. |
| `add <yaml>` | Validate and write a rule to the user layer. |
| `remove <id>` | Remove a rule from the user layer (other layers are not editable here). |
| `edit <id> <yaml>` | Replace a user-layer rule by id. |
| `test "<command>"` | Dry-run a bash command: the decision, deciding rule id, layer, and per-piece breakdown. Never writes anything. |
| `log` | Recent audit entries, newest first. |
| `status` | Posture, per-layer rule counts, rule-file paths. |
| `migrate [--apply]` | Plan (or apply) the legacy settings migration — see below. |

## Settings

```yaml
permissions:
  default: prompt       # allow | prompt | deny — default posture
  llmSuggestions: true  # LLM rule suggestions in the approval dialog
  audit:
    enabled: true       # write .omp/permissions-audit.jsonl
    maxEntries: 10000   # rotation bound
```

## Legacy settings and migration

Legacy keys continue to work without rewriting user files; they are mapped into the engine in memory:

| Legacy | Mapping |
| ------ | ------- |
| `tools.approvalMode: yolo` | `permissions.default: allow` |
| `tools.approvalMode: write` | `permissions.default: prompt` (write-tier tools now prompt instead of auto-approving — slightly stricter by design; add allow rules to restore) |
| `tools.approvalMode: always-ask` | `permissions.default: prompt` |
| `tools.approval.<tool>: allow\|deny\|prompt` | legacy-layer rules for that tool (deny still absolute; `prompt` forces the dialog; `allow` auto-approves without the shell-control guard — matching legacy behavior — until migrated to a user-layer rule, which is subject to the guard) |
| `bash.patterns` (`match`/`approval`) | legacy-layer bash rules (`deny`/`prompt` match any piece text; `allow` applies to single-piece commands only) |

While any legacy key is configured, a one-time notice lists the mapping that applies to the current config (shown once per interactive session start, until the config is clean).

A pre-migration `tools.approval.<tool>: allow` resolves at pipeline step 8 as an **unconditional allow**, bypassing the shell-control guard that applies to rule-based allows at step 9 — this matches the old behavior. Migrating the key turns it into a user-layer `{ arg: "*" }` rule that goes through the step-9 guard, so a bash command carrying shell-control syntax then degrades to a prompt instead of auto-approving.

`/permissions migrate` rewrites the legacy keys into rule files:

- **Dry-run by default** (`/permissions migrate`); add `--apply` to execute.
- Migrated rules are written to the **user layer** (`~/.omp/agent/permissions.yml`), merged by deterministic `legacy-<tool>-<index>` ids — re-applying the same plan replaces instead of duplicating, so migration is idempotent.
- Legacy keys are removed from the global `config.yml` (`tools.approvalMode`, `tools.approval`, `bash.patterns`). Keys that live only in a project or runtime settings layer cannot be removed through settings writes — they are excluded from removal and flagged with a notice; delete them from their source config after migrating.
- The migration does not write a `permissions` block into `config.yml`; the notices tell you what to configure (`permissions.default` etc.) to keep your current posture.
