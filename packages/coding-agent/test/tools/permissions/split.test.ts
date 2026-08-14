import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	isSinglePiece,
	nestedCommandTexts,
	parseCommand,
	scanRedirectWrites,
	stripFileWriteRedirects,
} from "@oh-my-pi/pi-coding-agent/tools/permissions/split";
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

	it("splits [[ ]] test commands like any other command", () => {
		const pieces = piecesOf("[[ -d foo ]] && echo yes");
		expect(pieces).toHaveLength(2);
		expect(pieces[0].text).toContain("[[ -d foo");
		expect(pieces[1].text).toContain("echo yes");
		expect(pieces[1].operator).toBe("&&");
	});

	it("keeps arithmetic expressions whole", () => {
		const pieces = piecesOf("(( x = 1 ))");
		expect(pieces).toHaveLength(1);
		expect(pieces[0].operator).toBeNull();
		expect(pieces[0].text).toBe("((x = 1))"); // brush-rendered node text, not the raw input
	});

	it("keeps arithmetic and until loops whole", () => {
		const arithmeticFor = piecesOf("for ((i=0; i<3; i++)); do echo $i; done");
		expect(arithmeticFor).toHaveLength(1);
		expect(arithmeticFor[0].text).toContain("for ((");
		expect(arithmeticFor[0].text).toContain("\ndo\n"); // brush renders compound bodies multi-line
		const until = piecesOf("until false; do echo x; done");
		expect(until).toHaveLength(1);
		expect(until[0].text).toBe("until false; do\n    echo x\ndone"); // brush rendering keeps `do` on the condition line
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

	it("surfaces until loops as nested compounds", () => {
		const nodes: unknown[] = JSON.parse(natives.parseShellCommand("cd x && until false; do echo y; done"));
		const texts = nestedCommandTexts(nodes);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("until");
	});

	it("reports nothing when the command has no compound nodes", () => {
		const nodes: unknown[] = JSON.parse(natives.parseShellCommand("rm -rf $(git rev-parse HEAD)"));
		expect(nestedCommandTexts(nodes)).toEqual([]); // command substitution is not a compound node
	});
});

describe("scanRedirectWrites", () => {
	it("collects >-family file write targets grammar-level", () => {
		expect(scanRedirectWrites("echo hi > /tmp/x")).toEqual({
			present: true,
			targets: ["/tmp/x"],
			unattributable: false,
		});
		expect(scanRedirectWrites("echo hi >> /tmp/x 2> err")).toEqual({
			present: true,
			targets: ["/tmp/x", "err"],
			unattributable: false,
		});
		expect(scanRedirectWrites("echo hi &> all")).toEqual({ present: true, targets: ["all"], unattributable: false });
	});

	it("collects redirects from pipeline and compound children", () => {
		expect(scanRedirectWrites("ls -la | grep foo > out")).toEqual({
			present: true,
			targets: ["out"],
			unattributable: false,
		});
		expect(scanRedirectWrites("cd /tmp > out && echo done")).toEqual({
			present: true,
			targets: ["out"],
			unattributable: false,
		});
	});

	it("ignores fd duplication, input redirects, and heredocs", () => {
		expect(scanRedirectWrites("echo hi 2>&1")).toEqual({ present: false, targets: [], unattributable: false });
		expect(scanRedirectWrites("cat < in.txt > out.txt")).toEqual({
			present: true,
			targets: ["out.txt"],
			unattributable: false,
		});
		expect(scanRedirectWrites("cat <<EOF\nhi\nEOF")).toEqual({ present: false, targets: [], unattributable: false });
	});

	it("marks quoted or expanded targets unattributable", () => {
		expect(scanRedirectWrites('echo hi > "$x"')).toEqual({ present: true, targets: [], unattributable: true });
	});

	it("fails closed (null) when the command does not parse", () => {
		expect(scanRedirectWrites("echo 'unterminated")).toBeNull();
	});
});

describe("stripFileWriteRedirects", () => {
	it("removes file writes and fd duplication, keeping input redirects", () => {
		expect(stripFileWriteRedirects("echo hi 2>&1")).toBe("echo hi ");
		expect(stripFileWriteRedirects("cd /tmp > out")).toBe("cd /tmp ");
		expect(stripFileWriteRedirects("cat < in.txt > out.txt")).toBe("cat < in.txt ");
	});

	it("strips inside compound texts and returns parse failures unchanged", () => {
		expect(stripFileWriteRedirects("cd /tmp > out && echo done")).toBe("cd /tmp  && echo done");
		expect(stripFileWriteRedirects("echo 'unterminated")).toBe("echo 'unterminated");
	});
});
