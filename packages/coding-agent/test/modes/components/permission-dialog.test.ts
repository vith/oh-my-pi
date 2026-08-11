import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { PermissionDialogOption } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { PermissionDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/permission-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

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
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
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
		component.handleInput("j");
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
});
