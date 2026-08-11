import { CRITICAL_BASH_PATTERNS } from "../bash";

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
