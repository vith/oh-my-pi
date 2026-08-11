# permissions

> Inspects and dry-runs the permission rule engine. The model-facing tool is read-only (`list` / `test`); rule edits stay with the user via the `/permissions` slash command.

## Source
- Entry: `packages/coding-agent/src/tools/permissions/manage.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/permissions.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/permissions/rules.ts` — layer loading, `normalizeRule`, and the locked `writeUserRule` / `removeUserRule` writers.
  - `packages/coding-agent/src/tools/permissions/engine.ts` — `evaluateBashCommand` (test dry-run) and `resolvePosture` (status).
  - `packages/coding-agent/src/tools/permissions/audit.ts` — audit read for match counts, `show` hits, and `log`.
  - `packages/coding-agent/src/tools/permissions/migrate.ts` — `planMigration` / `applyMigration` for the `migrate` subcommand.
  - `packages/coding-agent/src/tools/index.ts` + `packages/coding-agent/src/tools/builtin-names.ts` — tool registration.
  - `packages/coding-agent/src/slash-commands/builtin-registry.ts` — `/permissions` slash command.
  - `packages/coding-agent/src/tools/permissions/curated.ts` — `CURATED_ALLOW_TOOLS` lists the tool, so it never prompts.

## Inputs

Model tool parameters (single root object):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"list" \| "test"` | Yes | `list` prints the merged file-backed rules by layer; `test` dry-runs a bash command. No other action exists — the schema rejects mutations. |
| `command` | `string` | For `test` | The bash command to dry-run. |

The `/permissions` slash command accepts the same surface as free text:

| Subcommand | Effect |
| --- | --- |
| `list` | Merged rules by layer (dynamic → project → user) with audit match counts. |
| `show <id>` | One rule's details plus its last five audit hits. |
| `add <yaml>` | Validates a rule via `normalizeRule` and writes it to the user file. |
| `remove <id>` | Removes a rule from the user file. |
| `edit <id> <yaml>` | Replaces a user-file rule by id (an explicit id in the yaml renames). |
| `test "<command>"` | Dry-run: prints the decision, deciding rule id, layer, source, reason, and per-piece results. |
| `log` | The 50 most recent audit entries, newest first. |
| `status` | Posture, per-layer rule counts, and rule file paths. |
| `migrate [--apply]` | Prints the legacy-settings migration plan; `--apply` runs `applyMigration`. |

## Outputs
- Both surfaces return a single text part.
- `list` prints one section per file-backed layer in precedence order, each rule as `id [audit hits] tool match action`, then any rule-load errors.
- `test` prints `decision:` / `rule:` / `layer:` / `source:` / `reason:` lines followed by per-piece evaluations. It never writes to disk.
- Errors (invalid yaml, unknown ids, unknown subcommands) are returned as plain-text messages; the tool result is not marked as an error for recoverable user-input mistakes.

## Flow
1. `runPermissionCommand(args, ctx)` splits the first whitespace token and dispatches to a subcommand implementation.
2. `list` / `show` / `status` load file-backed layers via `loadRuleLayers(ctx.cwd)` (layers resolve against the OS home; `ctx` carries `cwd`, `settings`, and an optional `sessionId`).
3. `add` / `edit` parse the yaml, validate through `normalizeRule(record, "user")`, and persist through `writeUserRule` — the same locked read-modify-write used for dynamic rules (Task 2 deferred minor: all rule-file writes serialize under `withFileLock` from `@oh-my-pi/pi-utils/file-lock`).
4. `remove` targets the user layer only; when the id exists in another layer, the output says which layer owns it.
5. `test` calls `evaluateBashCommand(command, { settings, cwd })` — the same pipeline the bash tool's approval gate runs — and formats the decision.
6. `migrate` calls `planMigration(settings, cwd)`; with `--apply` it calls `applyMigration` (which requires the global settings singleton, per Task 9's contract).

## Side Effects
- Filesystem
  - `add` / `edit` / `remove` write the user rules file (`~/.omp/agent/permissions.yml`).
  - `migrate --apply` writes migrated rules and removes legacy settings keys.
  - `test`, `list`, `show`, `log`, `status`, and plain `migrate` are read-only.
- Session state
  - None. The model tool appends no transcript custom entries; its result is a plain tool result.

## Limits & Caps
- `log` caps output at the 50 most recent records.
- `show` prints at most the last five audit hits.
- The tool schema accepts exactly `"list"` and `"test"` — anything else fails validation, keeping the model-facing surface read-only.
- Tool execution mode: `approval = "read"` and the tool is in `CURATED_ALLOW_TOOLS`, so it never prompts.

## Errors
- `Invalid rule: a non-empty tool, a non-empty match mapping, and action allow|deny|prompt are required.` — `add`/`edit` input fails `normalizeRule`.
- `No rule with id "<id>" ...` — `show` / `remove` miss.
- `Rule "<id>" lives in the <layer> layer (...)` — `remove` on a non-user-layer rule.
- `Unknown subcommand "<name>".` — anything outside the documented surface, followed by usage.
- `Migration failed: <message>` — `applyMigration` threw (e.g. settings not initialized).

## Notes
- `writeDynamicRule` and `removeDynamicRule` keep their names (Task 2's contract); `writeUserRule` / `removeUserRule` share the same locked `writeRulesFile` machinery, and `writeRulesFile(file, rules)` is the general `{ rules }`-document writer.
- The dry-run `test` output is the exact engine decision, including curated-deny and posture sources, so it can explain why a command would be blocked even without a matching rule.
- Audit match counts come from `readAudit(auditFilePath(ctx.cwd))`; a missing audit file simply yields no counts.
