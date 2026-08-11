import { afterEach, describe, expect, it, vi } from "bun:test";
import { isSinglePiece, nestedCommandTexts, parseCommand } from "@oh-my-pi/pi-coding-agent/tools/permissions/split";
import * as natives from "@oh-my-pi/pi-natives";

function piecesOf(command: string) {
	const out = parseCommand(command);
	if (!out.ok) throw new Error(out.error);
	return out.pieces;
}

describe("parseCommand", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fails closed on syntax errors", () => {
		const out = parseCommand("echo 'unterminated");
		expect(out.ok).toBe(false);
		if (out.ok) throw new Error("expected a parse failure");
		expect(out.error).toContain("Shell parse error");
	});

	it("returns no pieces for empty or whitespace-only commands", () => {
		expect(piecesOf("")).toEqual([]);
		expect(piecesOf("   ")).toEqual([]);
	});

	it("keeps pipelines whole as one piece", () => {
		expect(piecesOf("ls -la | grep foo")).toEqual([{ text: "ls -la |grep foo", operator: null }]);
	});

	it("splits && || ; & and newlines into pieces with operators", () => {
		expect(piecesOf("a && b || c; d & e\nf")).toEqual([
			{ text: "a", operator: null },
			{ text: "b", operator: "&&" },
			{ text: "c", operator: "||" },
			{ text: "d", operator: ";" },
			{ text: "e", operator: "&" },
			{ text: "f", operator: ";" },
		]);
	});

	it("keeps nested compounds inside their piece", () => {
		const pieces = piecesOf("cd x && if true; then echo y; fi");
		expect(pieces).toHaveLength(2);
		expect(pieces[1].text).toContain("if true");
		expect(pieces[1].operator).toBe("&&");
	});

	it("keeps function definitions whole", () => {
		const pieces = piecesOf("foo() { echo hi; }");
		expect(pieces).toHaveLength(1);
		expect(pieces[0].operator).toBeNull();
		expect(pieces[0].text).toContain("foo");
	});

	it("collapses to one whole-command piece when node kinds are not understood", () => {
		const spy = vi.spyOn(natives, "parseShellCommand");
		spy.mockReturnValue(JSON.stringify([{ kind: "mysteryKind", text: "nope" }]));
		expect(parseCommand("echo hi")).toEqual({ ok: true, pieces: [{ text: "echo hi", operator: null }] });
		spy.mockReturnValue(
			JSON.stringify([
				{
					kind: "sequence",
					operator: ";",
					children: [{ kind: "simpleCommand", text: "a" }, { kind: "mysteryKind" }],
				},
			]),
		);
		expect(parseCommand("echo hi")).toEqual({ ok: true, pieces: [{ text: "echo hi", operator: null }] });
	});

	it("collapses to one whole-command piece when a piece text is missing", () => {
		vi.spyOn(natives, "parseShellCommand").mockReturnValue(JSON.stringify([{ kind: "simpleCommand" }]));
		expect(parseCommand("echo hi")).toEqual({ ok: true, pieces: [{ text: "echo hi", operator: null }] });
	});
});

describe("isSinglePiece", () => {
	it("distinguishes simple commands", () => {
		expect(isSinglePiece("git status")).toBe(true);
		expect(isSinglePiece("a && b")).toBe(false);
		expect(isSinglePiece("ls | grep x")).toBe(true); // pipeline = one piece
		expect(isSinglePiece("a; b")).toBe(false);
		expect(isSinglePiece("")).toBe(false);
		expect(isSinglePiece("echo 'unterminated")).toBe(false); // parse failure is not a single piece
	});
});

describe("nestedCommandTexts", () => {
	it("surfaces compounds nested inside a piece", () => {
		const nodes: unknown[] = JSON.parse(natives.parseShellCommand("cd x && if true; then echo y; fi"));
		const texts = nestedCommandTexts(nodes);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("if true");
	});

	it("reports nothing when the command has no compound nodes", () => {
		const nodes: unknown[] = JSON.parse(natives.parseShellCommand("rm -rf $(git rev-parse HEAD)"));
		expect(nestedCommandTexts(nodes)).toEqual([]); // command substitution is not a compound node
	});
});
