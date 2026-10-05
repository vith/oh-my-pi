import { describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

function createHarness() {
	const warnings: string[] = [];
	const statuses: string[] = [];
	let editorText = "submitted command";
	const snapshot = {
		running: [
			{ id: "bash-running", type: "bash", status: "running", label: "build", startTime: 1 },
			{ id: "task-running", type: "task", status: "running", label: "research", startTime: 1 },
		],
		recent: [{ id: "bash-finished", type: "bash", status: "completed", label: "check", startTime: 1 }],
	};
	const ctx = {
		session: { getAsyncJobSnapshot: () => ({ running: [], recent: [] }) },
		viewSession: { getAsyncJobSnapshot: () => snapshot },
		editor: {
			setText: (text: string) => {
				editorText = text;
			},
		},
		showWarning: (text: string) => {
			warnings.push(text);
		},
		showStatus: (text: string) => {
			statuses.push(text);
		},
		handleJobsCommand: (args: string) => controller.handleJobsCommand(args),
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	const runtime: TuiSlashCommandRuntime = { ctx };
	const provider = new CombinedAutocompleteProvider([...buildTuiBuiltinSlashCommands(runtime)], process.cwd());
	return { runtime, provider, warnings, statuses, editorText: () => editorText };
}

async function complete(provider: CombinedAutocompleteProvider, text: string) {
	return provider.getSuggestions([text], 0, text.length);
}

describe("builtin slash dispatch and autocomplete", () => {
	it("offers builtin command names in real autocomplete", async () => {
		const { provider } = createHarness();
		const jobs = await complete(provider, "/jobs");
		expect(jobs?.items.map(item => item.value)).toContain("jobs");
		const settings = await complete(provider, "/settings");
		expect(settings?.items.map(item => item.value)).toContain("settings");
	});

	it("completes /jobs follow through the real autocomplete provider", async () => {
		const { provider } = createHarness();
		const result = await complete(provider, "/jobs f");
		expect(result?.items.map(item => item.value)).toEqual(["follow "]);
	});

	it("completes only available bash job IDs from the viewed session", async () => {
		const { provider } = createHarness();
		const all = await complete(provider, "/jobs follow ");
		expect(all?.items.map(item => item.value)).toEqual(["follow bash-running ", "follow bash-finished "]);
		const filtered = await complete(provider, "/jobs follow bash-f");
		expect(filtered?.items.map(item => item.value)).toEqual(["follow bash-finished "]);
	});

	it("consumes /jobs follow and surfaces the real missing-job diagnostic locally", async () => {
		const harness = createHarness();
		expect(await executeBuiltinSlashCommand("/jobs follow missing", harness.runtime)).toBe(true);
		expect(harness.warnings.join("\n")).toMatch(/missing.*not available/i);
		expect(harness.editorText()).toBe("");
	});

	it("consumes unsupported arguments to a known builtin with local usage", async () => {
		const harness = createHarness();
		expect(await executeBuiltinSlashCommand("/settings unexpected", harness.runtime)).toBe(true);
		expect(harness.statuses.join("\n")).toMatch(/usage:.*\/settings/i);
		expect(harness.editorText()).toBe("");
	});

	it("offers the existing collab start verb", async () => {
		const { provider } = createHarness();
		const result = await complete(provider, "/collab sta");
		expect(result?.items.map(item => item.value)).toContain("start ");
	});

	it("completes declared multiword memory subcommands after the first word", async () => {
		const { provider } = createHarness();
		const result = await complete(provider, "/memory mm h");
		expect(result?.items.map(item => item.value)).toEqual(["mm history "]);
	});

	it("stops nested subcommand completion once a complete verb has arguments", async () => {
		const { runtime } = createHarness();
		const memory = buildTuiBuiltinSlashCommands(runtime).find(command => command.name === "memory");
		expect(await memory?.getArgumentCompletions?.("mm history model-id")).toBeNull();
	});

	it("offers the supported skills help subcommand", async () => {
		const { provider } = createHarness();
		const result = await complete(provider, "/skills h");
		expect(result?.items.map(item => item.value)).toEqual(["help "]);
	});

	it("leaves unknown slash paths available to other dispatchers", async () => {
		const harness = createHarness();
		expect(await executeBuiltinSlashCommand("/custom-command argument", harness.runtime)).toBe(false);
		expect(await executeBuiltinSlashCommand("/skill:custom argument", harness.runtime)).toBe(false);
		expect(harness.statuses).toEqual([]);
		expect(harness.editorText()).toBe("submitted command");
	});
});
