Inspect the permission rule system. This tool is READ-ONLY: it never adds, removes, or edits rules — policy changes stay with the user via the /permissions command.

- `action: "list"` — show all file-backed rules (dynamic, project, user layers in precedence order) with audit match counts.
- `action: "test"` — dry-run a bash command against the permission engine and report the decision, the deciding rule id, and its layer. Nothing is written.

Use `list` to see which rules exist before asking the user to change policy. Use `test` to verify whether a command would be allowed, denied, or prompted.
