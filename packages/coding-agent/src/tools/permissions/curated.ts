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
	return SAFE_CONSUMER_COMMANDS.has(base);
}
