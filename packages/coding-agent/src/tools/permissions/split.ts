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

export function isSinglePiece(command: string): boolean {
	const out = parseCommand(command);
	if (!out.ok) return false;
	return out.pieces.length === 1 && out.pieces[0].operator === null;
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
