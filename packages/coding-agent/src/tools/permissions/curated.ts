import { CRITICAL_BASH_PATTERNS } from "./critical-patterns";

export const CURATED_ALLOW_TOOLS = [
	"read",
	"glob",
	"grep",
	"todo",
	"recall",
	"reflect",
	"web_search",
	"ast_grep",
	"ask",
	"permissions",
] as const;

export const CURATED_DENY_PATTERNS: readonly RegExp[] = CRITICAL_BASH_PATTERNS;

export function matchCuratedDeny(toolName: string, command: string | undefined): { pattern: RegExp } | null {
	if (toolName !== "bash" || typeof command !== "string" || command.length === 0) return null;
	const pattern = CURATED_DENY_PATTERNS.find(p => p.test(command));
	return pattern ? { pattern } : null;
}

/**
 * Curated safe-consumer set (spec §3.4): pure read/filter pipeline stages that
 * are exempt from the stage rule check when no rule matches them. Excluded by
 * design: sed (-i writes), awk (system()), xargs (executes), interpreter
 * flags (-c/-e/-Command), and anything that can execute or write.
 */
export const SAFE_CONSUMER_COMMANDS: ReadonlySet<string> = new Set([
	"head",
	"tail",
	"grep",
	"egrep",
	"wc",
	"sort",
	"uniq",
	"tr",
	"cut",
	"cat",
	"nl",
	"tac",
	"rev",
	"paste",
	"join",
	"column",
	"fmt",
	"fold",
	"pr",
	"comm",
	"diff",
	"cmp",
	"jq",
	"less",
	"more",
	"md5sum",
	"sha1sum",
	"sha224sum",
	"sha256sum",
	"sha384sum",
	"sha512sum",
]);

/** First token of a stage, with a leading path stripped (`/usr/bin/head` → `head`). */
export function isSafeConsumerStage(stage: string): boolean {
	const token = stage.trim().split(/\s+/u)[0] ?? "";
	const base = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
	if (!SAFE_CONSUMER_COMMANDS.has(base)) return false;
	// §3.4 conservative scan: redirections, command substitutions, and shell
	// control would smuggle unanalyzed write/exec content past the exemption,
	// so any marker disqualifies the stage. Over-rejection only over-prompts,
	// which is safe. (Inlined here rather than importing the engine's shell-
	// control helper — curated.ts is imported by engine.ts, so that would be
	// a circular import.)
	if (UNSAFE_STAGE_MARKERS.some(marker => stage.includes(marker))) return false;
	// Per-command write flags: sort -o / --output= write their output.
	if ((STAGE_WRITE_FLAGS[base] ?? []).some(flag => stage.includes(flag))) return false;
	return true;
}

/** Markers that make a stage unsafe to exempt: redirections, substitutions, control. */
const UNSAFE_STAGE_MARKERS: readonly string[] = [">", "<", "$(", "`", ";", "&"];

/** Per-command write flags that disqualify an otherwise-safe consumer (`grep -o` is read-only and stays allowed). */
const STAGE_WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
	sort: ["-o", "--output=", "--output"],
};
