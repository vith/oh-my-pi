import * as natives from "@oh-my-pi/pi-natives";

export interface ShellPiece {
	text: string;
	operator: ";" | "&&" | "||" | "&" | null;
}

export type ParseOutcome = { ok: true; pieces: ShellPiece[] } | { ok: false; error: string };

interface RawNode {
	kind: string;
	text?: string;
	operator?: string;
	words?: string[];
	redirects?: string[];
	/**
	 * Command texts of `$(…)`/backtick substitutions inside a simple command's
	 * words, collected grammar-level by the Rust parser (quote-aware, nested
	 * through double quotes and parameter-expansion values).
	 */
	substitutions?: string[];
	/** Set when a word carries substitution syntax the word parser rejected. */
	substitutionsError?: boolean;
	children?: RawNode[];
}

/**
 * Node kinds that stay whole as one piece: plain commands, pipelines, and the
 * compound commands. Anything outside this set (or `sequence` at top level) is
 * not understood and aborts the split so the caller fails closed.
 */
const SINGLE_PIECE_KINDS = new Set([
	"simpleCommand",
	"pipeline",
	"ifClause",
	"whileClause",
	"untilClause",
	"forClause",
	"arithmeticForClause",
	"caseClause",
	"braceGroup",
	"subshell",
	"functionDefinition",
	"extendedTest",
	"arithmetic",
]);

/** Compound commands whose bodies are analyzed separately by permission checks. */
const NESTED_COMPOUND_KINDS = new Set([
	"ifClause",
	"whileClause",
	"untilClause",
	"forClause",
	"caseClause",
	"braceGroup",
	"subshell",
]);

export function parseCommand(command: string): ParseOutcome {
	if (command.trim().length === 0) return { ok: true, pieces: [] };
	try {
		const nodes = JSON.parse(natives.parseShellCommand(command)) as RawNode[];
		const pieces = splitIntoPieces(nodes);
		if (pieces.length === 0 || pieces.some(piece => piece.text.length === 0)) {
			return { ok: true, pieces: [{ text: command.trim(), operator: null }] };
		}
		return { ok: true, pieces };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function splitIntoPieces(nodes: Array<{ kind: string; operator?: string; children?: unknown[] }>): ShellPiece[] {
	return splitTopLevel(nodes as RawNode[]);
}

/**
 * Splits the top-level node list into pieces. `sequence` nodes decompose into
 * their children (`and`/`or` wrappers become `&&`/`||` pieces, plain children
 * carry the sequence operator), every other known kind is one piece, and the
 * first piece of each top-level node carries the operator that terminated the
 * previous one (`;` for non-sequence nodes, i.e. newline or `;`). Any node
 * kind not understood returns no pieces at all so `parseCommand` collapses to
 * a single whole-command piece.
 */
function splitTopLevel(nodes: RawNode[]): ShellPiece[] {
	const pieces: ShellPiece[] = [];
	let previous: RawNode | null = null;
	for (const node of nodes) {
		if (node.kind === "sequence") {
			const children = node.children ?? [];
			if (children.length === 0) return [];
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (child.kind === "and" || child.kind === "or") {
					const operator: ShellPiece["operator"] = child.kind === "and" ? "&&" : "||";
					for (const pipe of child.children ?? []) {
						if (!SINGLE_PIECE_KINDS.has(pipe.kind)) return [];
						pieces.push({ text: pipe.text?.trim() ?? "", operator });
					}
				} else {
					if (!SINGLE_PIECE_KINDS.has(child.kind)) return [];
					pieces.push({
						text: child.text?.trim() ?? "",
						operator: i === 0 ? terminatorOf(previous) : node.operator === "&" ? "&" : ";",
					});
				}
			}
		} else {
			if (!SINGLE_PIECE_KINDS.has(node.kind)) return [];
			pieces.push({ text: node.text?.trim() ?? "", operator: previous === null ? null : terminatorOf(previous) });
		}
		previous = node;
	}
	return pieces;
}

/** Operator that terminated `node` and therefore precedes the next top-level piece. */
function terminatorOf(node: RawNode | null): ShellPiece["operator"] {
	if (node === null) return null;
	return node.kind === "sequence" ? (node.operator === "&" ? "&" : ";") : ";";
}

/**
 * File-writing `>`-family redirects: `>`, `>>`, fd-prefixed (`2>`), `&>`
 * (both streams), and `>|` (noclobber). Everything else in brush's redirect
 * set is input (`<`, heredocs, herestrings) or fd duplication.
 */
const FILE_WRITE_REDIRECT_RE = /^(?:\d*&?>>?|&>|>\|)\s*(\S+)$/u;
/** fd duplication (`2>&1`, `>&2`, `<&N`) — brush renders these as `2>& 1`. */
const FD_DUP_REDIRECT_RE = /^(?:\d*>&|\d*<&)/u;

/** All `redirects` entries across an AST, recursively (pipeline/compound children included). */
function collectRedirects(nodes: RawNode[]): string[] {
	const out: string[] = [];
	const visit = (node: RawNode): void => {
		out.push(...(node.redirects ?? []));
		for (const child of node.children ?? []) visit(child);
	};
	for (const node of nodes) visit(node);
	return out;
}

export interface RedirectWriteScan {
	/** Any file-writing `>`-family redirect present at all. */
	present: boolean;
	/** Attributable simple-token file write targets. */
	targets: string[];
	/** A file redirect whose target is quoted/expanded and cannot be attributed. */
	unattributable: boolean;
}

/**
 * Scan a command's AST (Rust brush parser — the same parser that executes
 * bash) for file-writing `>`-family redirections, grammar-level and
 * quote-aware. Heredocs/herestrings and `<` input redirects are not writes;
 * `>&`/`<&` fd duplication is not a file write. Targets that are quoted or
 * expanded cannot be attributed and mark the scan unattributable — the
 * caller must not sanction that write. `null` when the command does not
 * parse, so callers fail closed.
 */
export function scanRedirectWrites(command: string): RedirectWriteScan | null {
	let nodes: RawNode[];
	try {
		nodes = JSON.parse(natives.parseShellCommand(command)) as RawNode[];
	} catch {
		return null;
	}
	const targets: string[] = [];
	let present = false;
	let unattributable = false;
	for (const redirect of collectRedirects(nodes)) {
		if (redirect.startsWith("<") || FD_DUP_REDIRECT_RE.test(redirect)) continue;
		const match = FILE_WRITE_REDIRECT_RE.exec(redirect);
		if (match === null) continue;
		present = true;
		const target = match[1];
		if (/^[A-Za-z0-9_./~+:-]+$/u.test(target)) targets.push(target);
		else unattributable = true;
	}
	return { present, targets, unattributable };
}

/**
 * Remove file-writing and fd-duplication redirections from a command text,
 * leaving input redirects (`<`, heredocs) and everything else intact. Used to
 * re-evaluate the base command when redirections are its only shell control.
 * Returns the original text when the command does not parse (fail-closed).
 */
export function stripFileWriteRedirects(command: string): string {
	let nodes: RawNode[];
	try {
		nodes = JSON.parse(natives.parseShellCommand(command)) as RawNode[];
	} catch {
		return command;
	}
	let base = command;
	for (const redirect of collectRedirects(nodes)) {
		if (redirect.startsWith("<")) continue;
		// brush renders fd duplication with a normalized space (`2>&1` →
		// `2>& 1`); compact-match those so the source form is removed too.
		// File redirects match their source form exactly (a double-space
		// source simply does not strip — the caller fails closed safely).
		const form = FD_DUP_REDIRECT_RE.test(redirect) ? redirect.replace(/\s+/gu, "") : redirect;
		base = base.replaceAll(form, "");
	}
	return base;
}

export function isSinglePiece(command: string): boolean {
	const out = parseCommand(command);
	if (!out.ok) return false;
	return out.pieces.length === 1 && out.pieces[0].operator === null;
}

/**
 * True when the command parses as a top-level pipeline node. Fail-closed:
 * parse errors or non-pipeline kinds return false.
 */
export function isPipeline(command: string): boolean {
	const node = parseCommandNode(command);
	return node !== null && node.kind === "pipeline";
}

/**
 * Maximum nesting depth for sub-command evaluation; deeper structures are
 * treated as unanalyzable and the caller degrades to a prompt.
 */
const SUB_COMMAND_MAX_DEPTH = 8;

/**
 * Extract the analyzable sub-commands of a piece: pipeline stages and the
 * `$(…)`/backtick command substitutions the Rust parser collected from the
 * piece's words (grammar-level, quote-aware). Returns:
 *   - `[]`          — no sub-commands (plain simple command),
 *   - `string[]`    — the sub-command texts, in execution order,
 *   - `null`        — the piece carries shell control that cannot be analyzed
 *                     (unparseable structure, non-simple pipeline stage,
 *                     nesting deeper than {@link SUB_COMMAND_MAX_DEPTH}).
 */
export function extractSubCommands(pieceText: string, depth = 0): string[] | null {
	if (depth >= SUB_COMMAND_MAX_DEPTH) return null;

	const node = parseCommandNode(pieceText);
	if (node === null || node.substitutionsError === true) return null;

	const subs = [...(node.substitutions ?? [])];

	// Pipeline stages are separate simpleCommand children of the pipeline node.
	if (node.kind === "pipeline") {
		const stages: string[] = [];
		for (const child of node.children ?? []) {
			if (child.kind !== "simpleCommand" || child.text === undefined) return null;
			stages.push(child.text.trim());
		}
		return [...subs, ...stages];
	}
	return subs;
}

function parseCommandNode(text: string): RawNode | null {
	try {
		const nodes = JSON.parse(natives.parseShellCommand(text)) as RawNode[];
		return nodes.length === 1 ? nodes[0] : null;
	} catch {
		return null;
	}
}

export function nestedCommandTexts(nodes: unknown[]): string[] {
	const texts: string[] = [];
	const visit = (node: unknown): void => {
		if (!isNode(node)) return;
		if (NESTED_COMPOUND_KINDS.has(node.kind) && node.text !== undefined) texts.push(node.text);
		for (const child of node.children ?? []) visit(child);
	};
	for (const node of nodes) visit(node);
	return texts;
}

function isNode(value: unknown): value is RawNode {
	return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}
