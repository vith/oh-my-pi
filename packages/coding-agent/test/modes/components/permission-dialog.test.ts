import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import type { PermissionDialogOption } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { PermissionDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/permission-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\n";
const CANCEL = "\x07";

let darkTheme = await getThemeByName("dark");

function render(component: PermissionDialogComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("PermissionDialogComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("renders the title, context lines, and numbered options with YAML previews", () => {
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			["no rule — default posture", "1. git push — pending"],
			[
				{ label: "Allow once" },
				{ label: "Exact: git push", description: "tool: bash\nmatch:\n  command: git push\naction: allow" },
			],
			() => {},
			() => {},
		);
		const out = render(component);
		expect(out).toContain("Allow tool: bash");
		expect(out).toContain("no rule — default posture");
		expect(out).toContain("1. Allow once");
		expect(out).toContain("2. Exact: git push");
		expect(out).toContain("command: git push");
	});

	it("first navigation from no selection is direction-aware: j → row 0, k → last row", () => {
		const make = (selected: number[]) =>
			new PermissionDialogComponent(
				"Allow tool: bash",
				[],
				[{ label: "Allow once" }, { label: "Allow & remember…" }, { label: "Deny" }],
				index => selected.push(index),
				() => {},
			);
		// j/down from -1 lands on the first row.
		const downSelected: number[] = [];
		const down = make(downSelected);
		down.handleInput("j");
		down.handleInput(ENTER);
		expect(downSelected).toEqual([0]);
		// k/up from -1 treats the selection as just-before-start: last row.
		const upSelected: number[] = [];
		const up = make(upSelected);
		up.handleInput("k");
		up.handleInput(ENTER);
		expect(upSelected).toEqual([2]);
	});

	it("enter selects the highlighted option; j/k and arrows move; esc cancels", () => {
		const selected: number[] = [];
		let cancelled = 0;
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Allow & remember…" }, { label: "Deny" }],
			index => selected.push(index),
			() => {
				cancelled++;
			},
		);

		// No selection by default: Enter alone must not confirm; j moves first.
		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([0]);

		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([0, 1]);

		component.handleInput("k");
		component.handleInput(ENTER);
		expect(selected).toEqual([0, 1, 0]);

		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(selected).toEqual([0, 1, 0, 2]);

		component.handleInput(UP);
		component.handleInput(UP);
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(selected).toEqual([0, 1, 0, 2, 0]);

		component.handleInput(CANCEL);
		expect(cancelled).toBe(1);
	});

	it("addOption appends a selectable option (Task 11 async suggestions)", () => {
		const selected: number[] = [];
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			index => selected.push(index),
			() => {},
		);
		component.addOption({ label: "Pattern: git *", description: "action: allow" });
		expect(render(component)).toContain("2. Pattern: git *");
		// First j enters the list (row 0); second reaches the appended row 1.
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("shows a spinner row while suggestions are pending and appends them on settle", async () => {
		const selected: number[] = [];
		const deferred = Promise.withResolvers<PermissionDialogOption[]>();
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			index => selected.push(index),
			() => {},
			{ suggestions: deferred.promise },
		);
		expect(render(component)).toContain("Suggesting rules…");
		deferred.resolve([{ label: "Allow bash: git push", description: "action: allow" }]);
		await deferred.promise;
		// Flush the component's .then chain.
		await Bun.sleep(0);
		const out = render(component);
		expect(out).not.toContain("Suggesting rules…");
		expect(out).toContain("2. Allow bash: git push");
		// First j enters the list (row 0); second reaches the appended row 1.
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("fires a lazy suggestion starter on mount and appends its options (issue 13)", async () => {
		const selected: number[] = [];
		const starter = vi.fn(async (): Promise<PermissionDialogOption[]> => [
			{ label: "Allow bash: git push", description: "action: allow" },
		]);
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			index => selected.push(index),
			() => {},
			{ suggestions: starter },
		);
		// Construction is presentation: the queued dialog's budget starts here.
		expect(starter).toHaveBeenCalledTimes(1);
		await starter.mock.results[0]?.value;
		// Flush the component's .then chain.
		await Bun.sleep(0);
		const out = render(component);
		expect(out).not.toContain("Suggesting rules…");
		expect(out).toContain("2. Allow bash: git push");
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("fires a lazy preselect starter on mount and applies the recommendation (issue 13)", async () => {
		const selected: number[] = [];
		const starter = vi.fn(async (): Promise<number | undefined> => 1);
		const component = new PermissionDialogComponent(
			"Approve this command?",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => selected.push(index),
			() => {},
			{ preselect: starter },
		);
		expect(starter).toHaveBeenCalledTimes(1);
		await starter.mock.results[0]?.value;
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("drops suggestions that resolve after the user already chose", async () => {
		const deferred = Promise.withResolvers<PermissionDialogOption[]>();
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			() => {},
			() => {},
			{ suggestions: deferred.promise },
		);
		// Enter alone is a no-op under no-selection; navigate, then confirm.
		component.handleInput("j");
		component.handleInput(ENTER);
		deferred.resolve([{ label: "Allow bash: git push" }]);
		await deferred.promise;
		await Bun.sleep(0);
		const out = render(component);
		expect(out).toContain("1. Allow once");
		expect(out).not.toContain("Allow bash: git push");
		expect(out).not.toContain("Suggesting rules…");
	});

	it("removes the spinner row when the suggestion promise rejects", async () => {
		const deferred = Promise.withResolvers<PermissionDialogOption[]>();
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			() => {},
			() => {},
			{ suggestions: deferred.promise },
		);
		expect(render(component)).toContain("Suggesting rules…");
		deferred.reject(new Error("provider down"));
		await Bun.sleep(0);
		const out = render(component);
		expect(out).not.toContain("Suggesting rules…");
		expect(out).toContain("1. Allow once");
	});

	it("requests a TUI repaint when suggestions settle so appended options get painted", async () => {
		const deferred = Promise.withResolvers<PermissionDialogOption[]>();
		const requestRender = vi.fn();
		const ui = { requestRender, requestDirectWrite: vi.fn() } as unknown as TUI;
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			() => {},
			() => {},
			{ suggestions: deferred.promise, ui },
		);
		deferred.resolve([{ label: "Allow bash: git push" }]);
		await deferred.promise;
		await Bun.sleep(0);
		const out = render(component);
		expect(out).toContain("2. Allow bash: git push");
		expect(out).not.toContain("Suggesting rules…");
		expect(requestRender).toHaveBeenCalled();
		component.dispose();
	});

	it("renders line segments with dim tails and right-aligned status", () => {
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[
				{
					segments: [{ text: "git log" }, { text: " |head -1", dim: true }],
					style: "text",
					status: { text: "no rule" },
				},
			],
			[{ label: "Allow once" }],
			() => {},
			() => {},
		);
		const out = render(component);
		const row = out.split("\n").find(line => line.includes("git log"));
		expect(row).toBeDefined();
		expect(row).toContain("|head");
		// The status is padded onto the same line, right-aligned to the width.
		expect(row).toContain("no rule");
	});

	it("initialIndex preselects an option (enter picks it)", () => {
		const selected: number[] = [];
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => selected.push(index),
			() => {},
			{ initialIndex: 1 },
		);
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("checklist mode: space toggles checked, rewrites labelFor labels, previews, and writes back to the source option", () => {
		const options: PermissionDialogOption[] = [
			{ label: "git log *", toggleable: true, checked: true },
			{ label: "Write checked (1)", labelFor: checked => `Write checked (${checked.filter(Boolean).length})` },
		];
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			options,
			() => {},
			() => {},
			// Space toggles the selected row; checklist flows preselect (Task 6).
			{
				checklist: true,
				initialIndex: 0,
				previewFor: checked => `Applying ${checked.filter(Boolean).length} rule(s)`,
			},
		);
		let out = render(component);
		expect(out).toContain("[x] git log *");
		expect(out).toContain("Write checked (1)");
		expect(out).toContain("Applying 1 rule(s)");

		component.handleInput(" ");
		out = render(component);
		expect(out).toContain("[ ] git log *");
		expect(out).toContain("Write checked (0)");
		expect(out).toContain("Applying 0 rule(s)");
		// The caller's option object receives the toggled state (Task 6 reads it).
		expect(options[0]?.checked).toBe(false);
	});

	it("checklist mode: enter on a toggleable row toggles it instead of settling", () => {
		const selected: number[] = [];
		const options: PermissionDialogOption[] = [
			{ label: "git log *", toggleable: true, checked: true },
			{ label: "Write checked (1)", labelFor: checked => `Write checked (${checked.filter(Boolean).length})` },
		];
		const component = new PermissionDialogComponent(
			"Remember allow — what rule?",
			[],
			options,
			index => selected.push(index),
			() => {},
			{ checklist: true, initialIndex: 0 },
		);
		component.handleInput(ENTER);
		// A row Enter must never settle the dialog (that used to deny the call).
		expect(selected).toEqual([]);
		expect(options[0]?.checked).toBe(false);
		expect(render(component)).toContain("[ ] git log *");
		// Only the write button (non-toggleable) commits.
		component.handleInput("j");
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("renders a custom help line when helpText is provided", () => {
		const component = new PermissionDialogComponent(
			"Remember allow — what rule?",
			[],
			[{ label: "x" }],
			() => {},
			() => {},
			{ checklist: true, helpText: "j/k navigate  space/enter toggle  esc back" },
		);
		expect(render(component)).toContain("j/k navigate  space/enter toggle  esc back");
	});

	it("applies the late model preselection while the dialog is untouched", async () => {
		const selected: number[] = [];
		const deferred = Promise.withResolvers<number | undefined>();
		const component = new PermissionDialogComponent(
			"Approve this command?",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => selected.push(index),
			() => {},
			{ preselect: deferred.promise },
		);
		deferred.resolve(1);
		await deferred.promise;
		component.handleInput(ENTER);
		expect(selected).toEqual([1]);
	});

	it("never applies the late preselection after the user interacted", async () => {
		const selected: number[] = [];
		const deferred = Promise.withResolvers<number | undefined>();
		const component = new PermissionDialogComponent(
			"Approve this command?",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => selected.push(index),
			() => {},
			{ preselect: deferred.promise },
		);
		component.handleInput("j"); // user moved first — the recommendation stays off
		deferred.resolve(1);
		await deferred.promise;
		component.handleInput(ENTER);
		expect(selected).toEqual([0]);
	});

	it("keeps a truncated line with a status on one row (status after the ellipsis)", () => {
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[{ segments: [{ text: "y".repeat(200) }], status: { text: "no rule" } }],
			[{ label: "Allow once" }],
			() => {},
			() => {},
		);
		const rows = render(component).split("\n");
		const ellipsisRow = rows.find(row => row.includes("…"));
		expect(ellipsisRow).toBeDefined();
		expect(ellipsisRow!.trimEnd().endsWith("… no rule")).toBe(true);
		// The status is not wrapped onto its own second row (the help line also
		// contains "no rule"; only the line row ends with the status).
		expect(rows.filter(row => row.trimEnd().endsWith("no rule"))).toHaveLength(1);
	});

	it("l toggles line truncation; truncated lines end with …", () => {
		const longLine = "x".repeat(200);
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[{ segments: [{ text: longLine }] }],
			[{ label: "Allow once" }],
			() => {},
			() => {},
		);
		let out = render(component);
		const row = out.split("\n").find(line => line.includes("…"));
		expect(row).toBeDefined();
		expect(row!.trimEnd().endsWith("…")).toBe(true);
		expect(row!.trimEnd().length).toBeLessThan(80);
		expect(out).not.toContain(longLine);

		component.handleInput("l");
		out = render(component);
		// Expanded text wraps across rows; join them to compare the full line.
		expect(
			out
				.split("\n")
				.map(line => line.trim())
				.join(""),
		).toContain(longLine);
	});

	it("e triggers onEdit when allowEdit is set; ignored without it", () => {
		const edited: number[] = [];
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			() => {},
			() => {},
			{ checklist: true, allowEdit: true, initialIndex: 1, onEdit: index => edited.push(index) },
		);
		component.handleInput("e");
		expect(edited).toEqual([1]);

		const unedited: number[] = [];
		const plain = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }],
			() => {},
			() => {},
			{ checklist: true },
		);
		plain.handleInput("e");
		expect(unedited).toEqual([]);

		// No selection (no initialIndex): e must not fire — an edit sentinel
		// for row -1 would collide with the plain-cancel sentinel.
		const noSelectionEdited: number[] = [];
		const noSelection = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			() => {},
			() => {},
			{ checklist: true, allowEdit: true, onEdit: index => noSelectionEdited.push(index) },
		);
		noSelection.handleInput("e");
		expect(noSelectionEdited).toEqual([]);
	});

	it("has no selected row by default: no highlight and enter is a no-op until navigation", () => {
		const selected: number[] = [];
		let cancelled = 0;
		const component = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => selected.push(index),
			() => {
				cancelled++;
			},
		);
		// No row is painted with the selection background before navigation.
		const bgPaint = darkTheme!.bg("selectedBg", "").replace(/\x1b\[49m$/u, "");
		const optionRow = () =>
			component
				.render(80)
				.join("\n")
				.split("\n")
				.find(line => line.includes("Allow once"));
		expect(optionRow()).not.toContain(bgPaint);

		component.handleInput(ENTER);
		expect(selected).toEqual([]);
		expect(cancelled).toBe(0);

		// Explicit -1 behaves like the omitted default.
		const explicitSelected: number[] = [];
		const explicit = new PermissionDialogComponent(
			"Allow tool: bash",
			[],
			[{ label: "Allow once" }, { label: "Deny" }],
			index => explicitSelected.push(index),
			() => {},
			{ initialIndex: -1 },
		);
		explicit.handleInput(ENTER);
		expect(explicitSelected).toEqual([]);

		// After navigation the row highlights and enter selects it.
		component.handleInput("j");
		expect(optionRow()).toContain(bgPaint);
		component.handleInput(ENTER);
		expect(selected).toEqual([0]);
	});
});
