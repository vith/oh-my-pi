# Permission demo feedback — 2026-08-14

All rules cleared, `permissions.default: prompt`. Found while demoing the
interactive permission dialogs. All open; fix on `feat/permissions-v3`.

## 1. No preselected recommended action on either dialog page

- **Repro:** any prompt with no matching rules.
- **Observed:** page 1 (decision: allow once / allow & remember / deny / deny
  & remember) and page 2 (scope/candidate with YAML previews) both render with
  no selection; the user must navigate before Enter does anything.
- **Expected:** the model suggests the action (allow/deny + scope) — "auto
  mode but with confirmation" — and the recommended option is preselected on
  both pages. The LLM suggestion provider already exists
  (`tools/permissions/suggest.ts`, `permissions.llmSuggestions`, async,
  appends rule options after the dialog renders); it never preselects
  anything.
- **Notes:** needs a decision-recommendation output from the provider plus
  preselection wiring (including the late-arrival case: preselect when
  suggestions land if the user hasn't moved yet).
- **Fixed (2026-08-14, round 2):** preselection exists on every page, but
  with the wrong mechanism — a deterministic least-commitment default
  ("Allow once"). **Correction (round 3): the MODEL decides.** The side
  completion now returns a `recommendation` (action + scope) that preselects
  the matching option when it lands (dialog applies it unless the user has
  already interacted); the scope page preselects the recommended scope.
  `permissions.llmSuggestions` gates only the extra rule options — the
  recommendation always runs. No recommendation (provider failure/off) ⇒ no
  preselection, per the model-decides design.

## 2. `echo "hello from bash"` flagged as unanalyzable shell control

- **Repro:** cleared rules; bash `echo "hello from bash"`; prompt shows
  "Remembered rules cannot suppress this prompt: … unanalyzable construct"
  and both remember options are dropped.
- **Expected:** a plain quoted command is fully analyzable; "Allow &
  remember" must be available.
- **Investigation (resolved):** probed `natives.parseShellCommand` from the
  current source: `echo "hello from bash"` parses to a single
  `simpleCommand` with empty substitutions, so `extractSubCommands` returns
  `[]` and `bashRememberDisabled` is false in the current code. The demo
  report predates the running build (fork.151) — the quoted-command case is
  already fixed; no further work needed here.

## 3. Compound remember checklist (allow all & remember) UX

- **a.** Enter on a piece row settles the dialog and **denies the whole
  call**: `rememberCompound` returns `undefined` for a piece-row pick
  (`labelFor === undefined`), and the caller resolves `undefined` as deny —
  while the help line says "enter select". Enter on a row should toggle it
  (or be a no-op); only the "Write checked rules" button should commit.
- **b.** `[x]` prefix on rows is ambiguous — reads as "excluded", but means
  "this rule will be written". Needs a clearer marker and/or legend.
- **c.** Spacebar toggles checkboxes but the help line
  ("j/k navigate  enter select  esc cancel — no rule written") documents
  neither space nor what `[x]` means.
- **Expected:** help text like "j/k navigate  space toggle  enter write checked  esc cancel",
  Enter toggles rows, only the write button commits, `[x]` = included.
- **Fixed (2026-08-14):** Enter on a toggleable row now toggles it (the
  dialog never settles on a row); only the write button commits. Help line
  reads "j/k navigate  space/enter toggle  enter write checked  esc back"
  and a legend line states "[x] rows are written as rules".

## 4. Allow & remember on a non-bash tool offers only a useless "exact" scope

- **Repro:** eval tool call → "Allow & remember…" → next page lists only
  "exact" (the full code blob) — never matches again, so remembering is
  pointless.
- **Expected:** either a useful scope for code tools (e.g. first-line /
  first-token pattern?) or drop the remember options for tools whose args are
  one-shot code (like shell-control bash does). **Design decision needed.**
- **Fixed (2026-08-14):** remember options are dropped (with a note —
  "Remembering this call would only match an identical call — no pattern
  scope applies to this tool") whenever every candidate scope is exact,
  i.e. eval-like tools. The dialog keeps Allow once + Deny.

## 5. Scope page has no way back to the decision page

- **Repro:** "Allow & remember…" (or "Deny & remember…") → scope page → the
  only exits are picking a candidate or esc, and esc **denies the whole
  call** (prompt.ts: "cancelled at scope level" → `{ policy: "deny" }`).
  Hit on eval, retain, and edit during the demo — each time the user was
  stuck: they wanted to back out to "Allow once" and the call was denied
  instead.
- **Expected:** the scope page needs a back option to the decision page, and
  "Allow once" must stay reachable from there; esc on the scope page goes
  back to page 1, esc on page 1 is the real cancel.
- **Fixed (2026-08-14):** esc on the scope page (allow/deny remember) and on
  the compound checklist now returns to the decision page; esc on the
  decision page is the only cancel (denies). Scope help line documents
  "esc back".

## 6. Concurrent pending approvals render out of order / detached from diffs

- **Repro:** two tool calls (SKILL.md edit, ISSUES.md edit) plus a todos
  update arrived together; the UI showed (SKILL.md edit diff) (ISSUES.md
  edit diff) (todos tree) (SKILL.md approval dialog) — the diff being
  approved was already offscreen.
- **Expected:** the approval dialog sits directly after the diff it is
  approving; further tool calls/messages in the turn do not render until
  earlier pending calls have been dealt with; the todos tree renders below
  the dialogs, not between a diff and its dialog.

## 7. Rule saved for worktree edits but prompt asked again

- **Repro:** user "allow + remember"ed an edit in the worktree with a glob;
  the next edit to the same area prompted again.
- **Possible causes to check:** the earlier allow&remember may have been
  silently converted to deny (bug 5) so no rule was written; rule layer /
  cwd mismatch (worktree path vs main checkout path, project vs user layer);
  glob too narrow for the actual path. Verify with `permissions list`.

## 8. No "Allow for this session" option

- **Repro:** any prompt; the decision page offers Allow once / Allow &
  remember… / Deny / Deny & remember… only.
- **Expected:** a session-scoped allow (e.g. "Allow for this session")
  that permits the call for the rest of the session without writing a
  persistent rule. Design: in-memory session-layer rule(s), not file-backed.

## 9. Custom glob editor accepts patterns that can never match the call

- **Repro:** user hand-typed `~/.omp/plugins/node_modules/superpowers/skills/*`
  in the Custom… glob editor for an edit at
  `/home/vith/.omp/plugins/.../SKILL.md`; rule saved but never matched —
  the engine does no `~` expansion (`matchPatternValue` compares the raw
  pattern to the raw absolute path), so the next identical edit prompted
  again.
- **Expected:** (a) the Custom… editor validates the edited pattern against
  the pending call's value before accepting (pattern must actually match);
  (b) path patterns expand `~` at match time (or the editor resolves to an
  absolute path before saving); (c) same validation applied to LLM
  suggestions.
- **Fixed (2026-08-14):** the engine expands a leading `~` in path-key
  patterns (and values) at match time — `~/.omp/**` rules now match absolute
  call paths, and command keys never expand (`cd ~/x` stays literal). The
  Custom… editor validates the edited glob against the pending call's value
  before accepting: a pattern that cannot match this call (wrong subcommand
  verb, glob narrower than the target) reopens the input with an error
  notification until it matches or the user escs. LLM suggestions that
  cannot match the pending call (checked against the call args, or any
  pending piece for compound bash) are dropped instead of appended as
  never-firing rule options. Also eliminates the most plausible remaining
  cause of bug 7 (glob too narrow for the actual path).

## 10. Are LLM rule suggestions real, and why are they never better?

- The pipeline exists: one-shot completion on the session model per pending
  call (`tools/permissions/suggest.ts`, gate `permissions.llmSuggestions`
  default true), appended to the dialog behind a spinner; every failure
  degrades silently to no suggestions. But the system prompt
  (`suggest.prompt.md`) is thin — "Pending call: …", "Cwd: …", current
  rules, "glob with *" — it never explains engine glob semantics (`*`
  crosses `/`, no `~` expansion, whitespace normalization) or shows the
  deterministic candidate shapes, so the model emits generic single-`*`
  patterns ("worktree/*") that look no better than the mechanical
  candidates. Nothing validates that a suggestion matches the pending call.
- **Expected:** richer prompt (candidate shapes, glob semantics, exact call
  text) + drop suggestions that don't match the pending call. Related to
  bug 1 (model should also recommend the action, preselected).
- **Decision (2026-08-14):** the fallback suggestion path is not worth
  keeping on by default — flip `permissions.llmSuggestions` to default
  **off** (keep the setting for opt-in).

## 11. Redirects/pipes flagged "unanalyzable" too aggressively

- **Repro:** `ls -t ~/.omp/logs/ 2>/dev/null | head -5` → note
  "unanalyzable construct", remember options dropped. The stderr redirect to
  `/dev/null` is benign and the pipeline is fully analyzable.
- **Expected:** analyze redirect targets — `2>/dev/null`, `>/dev/null` are
  safe and must not disable remember rules for otherwise-analyzable
  commands; the blanket redirect degradation (ruling R1) is too coarse.
  Related to bug 2.
- **Partial fix (2026-08-14):** the *allow-all posture* no longer prompts on
  unanalyzable residue (deep nesting / malformed substitutions) — the R1
  degradation in `evaluateBashPiece` now applies only to rule-backed allows
  (posture allows skip it; sub-command recursion still enforces curated/rule
  denies). The remember-option suppression for redirects remains by design
  (a remembered rule genuinely cannot suppress that prompt).

## 12. No global setting for default posture on project-dir writes

- **Observed:** settings UI has nothing for "allow writes to the project
  directory by default" — only `permissions.default` (all tools, all
  paths).
- **Decision (2026-08-14):** add a global setting alongside
  `permissions.default` (same allow/prompt/deny enum) governing write
  tools whose target path is inside the project directory. Default
  `prompt` (preserves current behavior); user can set `allow`.

## Meta (not a demo bug)

- Worktrees/branches must never be removed automatically; always resume work
  on the existing branch/worktree. Skills updated accordingly
  (`finishing-a-development-branch`, `using-git-worktrees` in the superpowers
  plugin).
