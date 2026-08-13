import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, toError } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { Settings } from "../../config/settings";
import permissionsDescription from "../../prompts/tools/permissions.md" with { type: "text" };
import type { ToolSession } from "../index";
import { auditFilePath, readAudit } from "./audit";
import {
	evaluateBashCommand,
	matchClassOf,
	matchRule,
	patternSpecificity,
	resolvePosture,
	resolveWholeCommandRule,
} from "./engine";
import { applyMigration, planMigration } from "./migrate";
import {
	loadRuleLayers,
	normalizeRule,
	type PermissionRule,
	type RuleLayer,
	removeUserRule,
	ruleFiles,
	writeUserRule,
} from "./rules";

/**
 * The `/permissions` management surface (spec §8): a plain-text command
 * runner shared by the slash command (which passes the raw argument string)
 * and the read-only `permissions` model tool (which builds `list` / `test`
 * argument strings from its structured parameters).
 *
 * Subcommands:
 * - `list` — merged file-backed rules by layer (dynamic → project → user)
 *   with audit match counts when the audit file exists.
 * - `show <id>` — rule details plus its last audit hits.
 * - `add <yaml>` — validate via `normalizeRule` and write to the user file.
 * - `remove <id>` — delete from the user file.
 * - `edit <id> <yaml>` — replace a user-file rule by id.
 * - `test "<command>"` — dry-run `evaluateBashCommand`; prints decision,
 *   rule, layer, and the winning rule's match class (with specificity).
 *   Never writes anything.
 * - `log` — recent audit entries (newest first).
 * - `status` — posture, per-layer rule counts, rule file paths.
 * - `migrate [--apply]` — Task 9's plan (dry-run by default) or apply.
 */
export interface RunPermissionCommandContext {
	cwd: string;
	settings: Settings;
	sessionId?: string;
}

const FILE_LAYERS = ["dynamic", "project", "user"] as const;

export async function runPermissionCommand(args: string, ctx: RunPermissionCommandContext): Promise<string> {
	const { token, rest } = splitFirstToken(args.trim());
	switch (token) {
		case "list":
			return listRules(ctx);
		case "show":
			return showRule(rest, ctx);
		case "add":
			return addRule(rest, ctx);
		case "remove":
			return removeRule(rest, ctx);
		case "edit":
			return editRule(rest, ctx);
		case "test":
			return testCommand(rest, ctx);
		case "log":
			return auditLog(ctx);
		case "status":
			return status(ctx);
		case "migrate":
			return migrate(rest, ctx);
		case "":
			return usage();
		default:
			return `Unknown subcommand "${token}".\n${usage()}`;
	}
}

function usage(): string {
	return [
		"Usage: permissions <subcommand>",
		"  list                 merged rules by layer with audit match counts",
		"  show <id>            rule details + last audit hits",
		"  add <yaml>           add a rule to the user layer (validated)",
		"  remove <id>          remove a rule from the user layer",
		"  edit <id> <yaml>     replace a user-layer rule by id",
		'  test "<command>"     dry-run a bash command (decision + rule + layer + class)',
		"  log                  recent permission audit entries",
		"  status               posture, rule counts, rule file paths",
		"  migrate [--apply]    plan (or apply) the legacy settings migration",
	].join("\n");
}

/** Split the first whitespace-delimited token from the rest of the string. */
function splitFirstToken(input: string): { token: string; rest: string } {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
	return match ? { token: match[1] ?? "", rest: match[2] ?? "" } : { token: "", rest: "" };
}

/** Strip one pair of wrapping quotes when present; otherwise return as-is. */
function unquote(input: string): string {
	const trimmed = input.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function listRules(ctx: RunPermissionCommandContext): Promise<string> {
	const { rules, errors } = loadRuleLayers(ctx.cwd);
	const audit = await readAudit(auditFilePath(ctx.cwd));
	const counts = new Map<string, number>();
	for (const record of audit) {
		if (record.ruleId === undefined) continue;
		counts.set(record.ruleId, (counts.get(record.ruleId) ?? 0) + 1);
	}

	const lines = ["Permission rules by layer (highest precedence first):"];
	for (const layer of FILE_LAYERS) {
		lines.push("", `${layer}:`);
		const layerRules = rules.filter(rule => rule.layer === layer);
		if (layerRules.length === 0) {
			lines.push("  (none)");
			continue;
		}
		for (const rule of layerRules) {
			const count = counts.get(rule.id);
			const hits = count === undefined ? "" : ` [${count} ${count === 1 ? "audit hit" : "audit hits"}]`;
			const ttl = rule.ttl !== undefined ? ` ttl=${rule.ttl}s` : "";
			lines.push(
				`  - ${rule.id}${hits} tool=${rule.tool} match=${JSON.stringify(rule.match)} action=${rule.action}${ttl}`,
			);
		}
	}
	if (errors.length > 0) lines.push("", `Rule load errors: ${errors.join("; ")}`);
	return lines.join("\n");
}

async function showRule(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const id = rest.trim();
	if (id.length === 0) return "Usage: permissions show <id>";
	const { rules } = loadRuleLayers(ctx.cwd);
	const rule = rules.find(candidate => candidate.id === id);
	if (rule === undefined)
		return `No rule with id "${id}" in the file-backed layers. Use "permissions list" to see rule ids.`;

	const hits = (await readAudit(auditFilePath(ctx.cwd))).filter(record => record.ruleId === id);
	const lines = [
		`id: ${rule.id}`,
		`tool: ${rule.tool}`,
		`match: ${JSON.stringify(rule.match)}`,
		`action: ${rule.action}`,
		`layer: ${rule.layer}`,
	];
	if (rule.reason !== undefined) lines.push(`reason: ${rule.reason}`);
	if (rule.ttl !== undefined) lines.push(`ttl: ${rule.ttl}s`);
	lines.push(`audit hits: ${hits.length}`);
	for (const hit of hits.slice(0, 5)) {
		const command = hit.command !== undefined ? ` "${hit.command}"` : "";
		lines.push(`  ${new Date(hit.ts).toISOString()} ${hit.tool}${command} -> ${hit.decision}`);
	}
	return lines.join("\n");
}

async function addRule(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const yaml = rest.trim();
	if (yaml.length === 0) return "Usage: permissions add <yaml>";
	const parsed = parseAndNormalize(yaml);
	if (parsed === null)
		return "Invalid rule: a non-empty tool, a non-empty match mapping, and action allow|deny|prompt are required.";

	const file = ruleFiles(ctx.cwd).user;
	await writeUserRule(file, parsed.rule);
	return `Added rule "${parsed.rule.id}" to the user layer (${file}).`;
}

async function removeRule(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const id = rest.trim();
	if (id.length === 0) return "Usage: permissions remove <id>";
	const file = ruleFiles(ctx.cwd).user;
	if (await removeUserRule(file, id)) return `Removed rule "${id}" from the user layer.`;

	const { rules } = loadRuleLayers(ctx.cwd);
	const elsewhere = rules.find(rule => rule.id === id);
	if (elsewhere !== undefined) {
		const files = ruleFiles(ctx.cwd);
		const pathForLayer: Partial<Record<RuleLayer, string>> = {
			dynamic: files.dynamic,
			project: files.project,
			user: files.user,
		};
		const location = pathForLayer[elsewhere.layer] !== undefined ? ` (${pathForLayer[elsewhere.layer]})` : "";
		return `Rule "${id}" lives in the ${elsewhere.layer} layer${location}, which this command does not edit. Only user-layer rules can be removed here.`;
	}
	return `No rule with id "${id}" found in the file-backed layers. Use "permissions list" to see rule ids.`;
}

async function editRule(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const { token: id, rest: yaml } = splitFirstToken(rest.trim());
	if (id.length === 0 || yaml.trim().length === 0) return "Usage: permissions edit <id> <yaml>";
	const parsed = parseAndNormalize(yaml);
	if (parsed === null)
		return "Invalid rule: a non-empty tool, a non-empty match mapping, and action allow|deny|prompt are required.";

	const file = ruleFiles(ctx.cwd).user;
	// An explicit id in the yaml wins (a rename); otherwise the target id is kept.
	const effectiveId = parsed.hasExplicitId ? parsed.rule.id : id;
	if (effectiveId !== id) await removeUserRule(file, id);
	await writeUserRule(file, { ...parsed.rule, id: effectiveId });
	return effectiveId === id
		? `Updated rule "${effectiveId}" in the user layer.`
		: `Updated rule "${effectiveId}" in the user layer (renamed from "${id}").`;
}

/** Parse a rule yaml fragment and normalize it for the user layer, or `null`. */
function parseAndNormalize(yaml: string): { rule: PermissionRule; hasExplicitId: boolean } | null {
	let record: unknown;
	try {
		record = YAML.parse(yaml);
	} catch {
		return null;
	}
	if (!isRecord(record)) return null;
	const rule = normalizeRule(record, "user");
	if (rule === null) return null;
	return { rule, hasExplicitId: typeof record.id === "string" };
}

async function testCommand(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const command = unquote(rest);
	if (command.length === 0) return 'Usage: permissions test "<command>"';
	const decision = evaluateBashCommand(command, { settings: ctx.settings, cwd: ctx.cwd });
	// Whole-command winner (spec §3.1 step 2): the deciding rule's match class
	// and specificity explain why it beat the other matches. The engine
	// evaluates the tokenizer's normalized piece text (the parser glues `|` to
	// the next stage), so for single-piece commands resolve over that same
	// text; multi-piece commands fall back to the raw command.
	const { rules } = loadRuleLayers(ctx.cwd);
	const bestCommand =
		decision.pieces !== undefined && decision.pieces.length === 1 ? decision.pieces[0].text : command;
	const best = resolveWholeCommandRule(rules, "bash", { command: bestCommand });
	const commandPattern = best?.rule.match.command;
	const matchClass =
		best !== undefined && typeof commandPattern === "string" ? matchClassOf(commandPattern, bestCommand) : undefined;
	const specificity =
		best !== undefined && typeof commandPattern === "string"
			? patternSpecificity("command", commandPattern)
			: undefined;

	const lines = [`Dry-run: bash "${command}"`, `decision: ${decision.policy}`];
	if (decision.ruleId !== undefined) lines.push(`rule: ${decision.ruleId}`);
	if (decision.layer !== undefined) lines.push(`layer: ${decision.layer}`);
	if (decision.source !== undefined) lines.push(`source: ${decision.source}`);
	if (decision.reason !== undefined) lines.push(`reason: ${decision.reason}`);
	for (const piece of decision.pieces ?? []) {
		const attribution = piece.ruleId !== undefined ? ` (${piece.ruleId}, ${piece.layer ?? "?"})` : "";
		lines.push(`  piece: ${piece.text} -> ${piece.policy}${attribution}`);
	}
	// Annotate only when the file-backed whole-command winner actually produced
	// the decision: a legacy pattern, stage-level override, curated hard-deny,
	// or R1 degradation decides otherwise, and annotating a non-deciding rule
	// would contradict `decision:`.
	if (best !== undefined && decision.ruleId === best.rule.id) {
		if (matchClass !== undefined && specificity !== undefined) {
			lines.push(`class: ${matchClass} (specificity ${specificity})`);
		}
		const otherMatches = rules.filter(rule => matchRule(rule, "bash", { command: bestCommand })).length - 1;
		if (otherMatches > 0) {
			lines.push(`resolved: ${best.rule.id} beats ${otherMatches} other matches`);
		}
	}
	return lines.join("\n");
}

async function auditLog(ctx: RunPermissionCommandContext): Promise<string> {
	const file = auditFilePath(ctx.cwd);
	const records = await readAudit(file, 50);
	if (records.length === 0) return `No permission audit entries (audit file: ${file}).`;

	const lines = ["Recent permission audit entries (newest first):"];
	for (const record of records) {
		const command = record.command !== undefined ? ` "${record.command}"` : "";
		const attribution = record.ruleId !== undefined ? ` (${record.ruleId}, ${record.layer ?? "?"})` : "";
		const outcome = record.outcome !== undefined ? ` [${record.outcome}]` : "";
		lines.push(
			`  ${new Date(record.ts).toISOString()} ${record.tool}${command} -> ${record.decision}${attribution}${outcome}`,
		);
	}
	return lines.join("\n");
}

function status(ctx: RunPermissionCommandContext): string {
	const posture = resolvePosture(ctx.settings);
	const files = ruleFiles(ctx.cwd);
	const { rules, errors } = loadRuleLayers(ctx.cwd);
	const counts: Record<string, number> = { dynamic: 0, project: 0, user: 0 };
	for (const rule of rules) {
		counts[rule.layer] = (counts[rule.layer] ?? 0) + 1;
	}
	const lines = [
		`Posture: ${posture}`,
		"Rule counts:",
		`  dynamic: ${counts.dynamic ?? 0}`,
		`  project: ${counts.project ?? 0}`,
		`  user: ${counts.user ?? 0}`,
		"Files:",
		`  dynamic: ${files.dynamic}`,
		`  project: ${files.project}`,
		`  user: ${files.user}`,
	];
	if (errors.length > 0) lines.push(`Rule load errors: ${errors.join("; ")}`);
	return lines.join("\n");
}

async function migrate(rest: string, ctx: RunPermissionCommandContext): Promise<string> {
	const apply = rest.trim().toLowerCase() === "--apply" || rest.trim().toLowerCase() === "apply";
	const plan = planMigration(ctx.settings, ctx.cwd);
	if (apply) {
		try {
			await applyMigration(plan, ctx.cwd);
		} catch (error) {
			return `Migration failed: ${toError(error).message}`;
		}
		return ["Migration applied.", ...plan.notices].join("\n");
	}
	const lines = ["Migration plan (dry-run; add --apply to apply):"];
	if (plan.notices.length === 0) {
		lines.push("  Nothing to migrate.");
	} else {
		lines.push(...plan.notices.map(notice => `  ${notice}`));
	}
	return lines.join("\n");
}

// =============================================================================
// Read-only `permissions` model tool
// =============================================================================

export const permissionsSchema = type({
	action: "'list' | 'test'",
	"command?": type("string").describe("bash command to dry-run (required when action is test)"),
}).describe(
	"Inspect permission rules. Read-only: never modifies policy — rule edits stay with the user via /permissions.",
);

type PermissionsParams = typeof permissionsSchema.infer;

export class PermissionsTool implements AgentTool<typeof permissionsSchema> {
	readonly name = "permissions";
	readonly approval = "read" as const;
	readonly label = "Permissions";
	readonly description = permissionsDescription;
	readonly parameters = permissionsSchema;
	readonly strict = true;
	readonly summary = "List permission rules or dry-run a command against the permission engine (read-only)";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: PermissionsParams): Promise<AgentToolResult> {
		if (params.action === "list") {
			const text = await runPermissionCommand("list", this.#context());
			return { content: [{ type: "text", text }] };
		}
		if (params.command === undefined || params.command.length === 0) {
			return { content: [{ type: "text", text: 'permissions test requires a "command".' }], isError: true };
		}
		const text = await runPermissionCommand(`test ${params.command}`, this.#context());
		return { content: [{ type: "text", text }] };
	}

	#context(): RunPermissionCommandContext {
		return {
			cwd: this.session.cwd,
			settings: this.session.settings,
			sessionId: this.session.getSessionId?.() ?? undefined,
		};
	}
}
