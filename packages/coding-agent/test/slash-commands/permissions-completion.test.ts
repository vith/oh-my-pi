import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { buildTuiBuiltinSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `perm-completion-${Snowflake.next()}-`));
const home = path.join(tmp, "home");
const cwd = path.join(tmp, "project");
const userRulesFile = path.join(home, ".omp", "agent", "permissions.yml");
const dynamicRulesFile = path.join(home, ".omp", "agent", "permissions.dynamic.yml");
const projectRulesFile = path.join(cwd, ".omp", "permissions.yml");

beforeEach(() => {
	clearFsCache();
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(cwd, { recursive: true });
	// Rule layers resolve against the OS home; point it at the temp home.
	vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
	clearFsCache();
	vi.restoreAllMocks();
});

afterAll(() => {
	removeSyncWithRetries(tmp);
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Materialized /permissions with a fake runtime exposing only the cwd surface. */
function permissionsCompleter() {
	const runtime = {
		ctx: { sessionManager: { getCwd: () => cwd } },
	} as never as TuiSlashCommandRuntime;
	const command = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "permissions");
	if (command === undefined) throw new Error("permissions slash command not registered");
	return command.getArgumentCompletions ?? (() => null);
}

describe("/permissions rule-id completion", () => {
	it("completes subcommand names while the subcommand is being typed", async () => {
		const complete = permissionsCompleter();
		const matches = await complete("rem");
		expect(matches?.some(match => match.value === "remove ")).toBe(true);
	});

	it("completes user-layer rule ids after remove, filtered by prefix", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: git1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n  - id: npm1\n    tool: bash\n    match: { command: 'npm *' }\n    action: allow\n",
		);
		write(
			projectRulesFile,
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		write(
			dynamicRulesFile,
			"rules:\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);

		const complete = permissionsCompleter();
		const matches = await complete("remove ");

		const labels = matches?.map(match => match.label);
		expect(labels).toContain("git1");
		expect(labels).toContain("npm1");
		// remove only edits the user layer: other layers' ids must not complete.
		expect(labels).not.toContain("proj1");
		expect(labels).not.toContain("dyn1");

		const filtered = await complete("remove git");
		expect(filtered?.map(match => match.label)).toEqual(["git1"]);
	});

	it("completes user-layer ids after edit", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: git1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			projectRulesFile,
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);

		const complete = permissionsCompleter();
		const matches = await complete("edit ");

		expect(matches?.map(match => match.label)).toEqual(["git1"]);
	});

	it("completes ids from all file-backed layers after show", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: git1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);
		write(
			projectRulesFile,
			"rules:\n  - id: proj1\n    tool: write\n    match: { path: 'src/**' }\n    action: allow\n",
		);
		write(
			dynamicRulesFile,
			"rules:\n  - id: dyn1\n    tool: bash\n    match: { command: 'npm test' }\n    action: allow\n",
		);

		const complete = permissionsCompleter();
		const matches = await complete("show ");

		const labels = matches?.map(match => match.label).sort();
		expect(labels).toEqual(["dyn1", "git1", "proj1"]);
	});

	it("annotates completions with the rule summary", async () => {
		write(
			userRulesFile,
			"rules:\n  - id: git1\n    tool: bash\n    match: { command: 'git *' }\n    action: allow\n",
		);

		const complete = permissionsCompleter();
		const matches = await complete("remove ");

		expect(matches?.[0]?.description).toContain("bash");
		expect(matches?.[0]?.description).toContain("allow");
	});

	it("returns null for subcommands that take no rule id", async () => {
		const complete = permissionsCompleter();
		expect(await complete("add ")).toBeNull();
		expect(await complete("test ")).toBeNull();
		expect(await complete("log ")).toBeNull();
		expect(await complete("clear ")).toBeNull();
	});

	it("returns null for unknown subcommands and empty rule sets", async () => {
		const complete = permissionsCompleter();
		expect(await complete("frobnicate ")).toBeNull();
		expect(await complete("remove ")).toBeNull();
	});
});
