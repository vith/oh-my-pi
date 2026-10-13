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
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const transcript = path.join(root, "session.jsonl");
	const control = path.join(root, "control.jsonl");
	const controlFd = fs.openSync(control, "a");
	const storageUrl = new URL("../src/session/session-storage.ts", import.meta.url).href;
	const script = `
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import { FileSessionStorage } from ${JSON.stringify(storageUrl)};
const root = ${JSON.stringify(root)};
const writer = new FileSessionStorage().openWriter(path.join(root, "session.jsonl"));
await writer.append('{"type":"session_start"}\\n');
const logsDir = path.join(root, "logs");
await fs.mkdir(logsDir, { recursive: true });
const logSink = new RotatingFileSink({
	directory: logsDir,
	filenamePrefix: "omp",
	filenameSuffix: String(process.pid),
	maxBytes: 1 << 20,
	maxFiles: 2,
});
logSink.write("entry");
let output = "";
try {
	await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: root }, (_err, chunk) => {
		output += chunk;
	});
} finally {
	logSink.close();
	await writer.close();
}
console.log(output);
`;
	let output = "";
	try {
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe", controlFd],
			timeout: 15_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
		output = stdout;
		expect(exitCode, stderr).toBe(0);
	} finally {
		fs.closeSync(controlFd);
	}

	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), "control: an inheritable descriptor must reach the child").toContain(control);
	expect(inherited.join("\n")).not.toContain(transcript);
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
