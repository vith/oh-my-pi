/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool's native shell hands inheritable descriptors to external
 * commands. Explicit close-on-exec flags protect session and log files on
 * supported runtimes whose `fs.open*` defaults do not.
 *
 * Oracle: list the shell child's descriptor table. `sh -c` is required — a
 * bare `ls` resolves to an in-process builtin, whose `$$` is omp itself. Pass
 * the control descriptor into a probe process as an extra stdio entry, as in
 * `config-value-fd-inheritance.test.ts`, so it is deliberately inheritable
 * regardless of the runtime's file-open defaults. The probe opens the real
 * session and log writers before running the shell. /proc makes this
 * Linux-only; the helper's flag handling is
 * covered on every platform by `packages/utils/test/fs-open.test.ts`.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const sessionStorageUrl = pathToFileURL(path.join(import.meta.dir, "../src/session/session-storage.ts")).href;

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);
	const transcript = path.join(root, "session.jsonl");
	const logsDir = path.join(root, "logs");
	const control = path.join(root, "control.jsonl");

	const script = `import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import * as fsp from "node:fs/promises";
import { FileSessionStorage } from ${JSON.stringify(sessionStorageUrl)};

const writer = new FileSessionStorage().openWriter(${JSON.stringify(transcript)});
await writer.append('{"type":"session_start"}\\n');
await fsp.mkdir(${JSON.stringify(logsDir)}, { recursive: true });
const logSink = new RotatingFileSink({
	directory: ${JSON.stringify(logsDir)},
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	maxBytes: 1 << 20,
	maxFiles: 2,
});
logSink.write("entry");

let output = "";
try {
	await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: ${JSON.stringify(root)} }, (_err, chunk) => {
		output += chunk;
	});
} finally {
	logSink.close();
	await writer.close();
}
process.stdout.write(output);
`;

	const controlFd = fs.openSync(control, "a");
	let stdout: string;
	let stderr: string;
	let exitCode: number;
	try {
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: path.join(import.meta.dir, ".."),
			stdio: ["ignore", "pipe", "pipe", controlFd],
			timeout: 30_000,
		});
		[stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
	} finally {
		fs.closeSync(controlFd);
	}

	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	const inherited = stdout
		.split("\n")
		.filter(line => line.includes(root))
		.join("\n");
	expect(inherited, `control: an inheritable descriptor must reach the child\n${stdout}`).toContain(control);
	expect(inherited).not.toContain(transcript);
	expect(inherited).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
