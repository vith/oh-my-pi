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
	"forClause",
	"caseClause",
	"braceGroup",
	"subshell",
	"functionDefinition",
]);

/** Compound commands whose bodies are analyzed separately by permission checks. */
const NESTED_COMPOUND_KINDS = new Set(["ifClause", "whileClause", "forClause", "caseClause", "braceGroup", "subshell"]);

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
