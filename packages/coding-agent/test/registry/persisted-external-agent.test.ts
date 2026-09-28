import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagent } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-21T12:00:00.000Z",
		cwd: "/tmp",
	});
}

function validTranscript(id: string): string {
	return [
		sessionHeader(id),
		JSON.stringify({
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp: "2026-08-21T12:00:01.000Z",
			systemPrompt: "external worker",
			task: "# Target\nReview the external transcript.",
			tools: ["read"],
			agent: "reviewer",
		}),
		JSON.stringify({
			type: "message",
			id: "assistant",
			parentId: "init",
			timestamp: "2026-08-21T12:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The review is complete." }],
				provider: "anthropic",
				model: "claude-sonnet-5",
				stopReason: "stop",
				usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
			},
		}),
	].join("\n");
}

describe("registerPersistedSubagent", () => {
	it("registers an external persisted transcript as a parked child with its requested identity and history", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-");
		const sessionFile = path.join(tempDir.path(), "state-root", "external-worker.jsonl");
		await Bun.write(sessionFile, `${validTranscript("persisted-id")}\n`);
		const registry = new AgentRegistry();

		const result = await registerPersistedSubagent(registry, {
			id: "external-worker",
			displayName: "External worker",
			parentId: "Dispatch-42",
			sessionFile,
		});

		expect(result).toBe("registered");
		expect(registry.get("external-worker")).toMatchObject({
			id: "external-worker",
			displayName: "External worker",
			kind: "sub",
			parentId: "Dispatch-42",
			session: null,
			sessionFile,
			status: "parked",
			history: {
				agent: "reviewer",
				resolvedModel: "anthropic/claude-sonnet-5",
				metrics: { requests: 1, tokens: 30, tools: 0, cost: 0.5 },
			},
		});
	});

	it("is idempotent after it registers an external transcript", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-repeat-");
		const sessionFile = path.join(tempDir.path(), "external-worker.jsonl");
		await Bun.write(sessionFile, `${validTranscript("persisted-id")}\n`);
		const registry = new AgentRegistry();
		const input = { id: "external-worker", displayName: "External worker", parentId: "Dispatch-42", sessionFile };

		expect(await registerPersistedSubagent(registry, input)).toBe("registered");
		const first = registry.get(input.id);
		expect(await registerPersistedSubagent(registry, input)).toBe("existing");
		expect(registry.get(input.id)).toBe(first);
	});

	it("leaves an existing live generation untouched", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-live-");
		const sessionFile = path.join(tempDir.path(), "external-worker.jsonl");
		await Bun.write(sessionFile, `${validTranscript("persisted-id")}\n`);
		const registry = new AgentRegistry();
		const liveSession = {} as never;
		const live = registry.register({
			id: "external-worker",
			displayName: "Live worker",
			kind: "sub",
			parentId: "Live-parent",
			session: liveSession,
			sessionFile: "/tmp/live-worker.jsonl",
			status: "running",
		});

		expect(
			await registerPersistedSubagent(registry, {
				id: "external-worker",
				displayName: "External worker",
				parentId: "Dispatch-42",
				sessionFile,
			}),
		).toBe("existing");
		expect(registry.get("external-worker")).toBe(live);
		expect(registry.get("external-worker")).toMatchObject({
			displayName: "Live worker",
			parentId: "Live-parent",
			sessionFile: "/tmp/live-worker.jsonl",
			status: "running",
		});
	});

	it("reports a header-only transcript as incomplete without parking it", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-incomplete-");
		const sessionFile = path.join(tempDir.path(), "header-only.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("persisted-id")}\n`);
		const registry = new AgentRegistry();

		expect(
			await registerPersistedSubagent(registry, {
				id: "header-only",
				displayName: "Header only",
				sessionFile,
			}),
		).toBe("incomplete");
		expect(registry.get("header-only")).toBeUndefined();
	});

	it("rejects a malformed transcript without a persisted session contract", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-invalid-");
		const sessionFile = path.join(tempDir.path(), "invalid.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("persisted-id")}\n{not valid json}\n`);
		const registry = new AgentRegistry();

		expect(
			await registerPersistedSubagent(registry, {
				id: "invalid",
				displayName: "Invalid",
				sessionFile,
			}),
		).toBe("invalid");
		expect(registry.get("invalid")).toBeUndefined();
	});

	it("rejects malformed JSON after a persisted session contract", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-invalid-tail-");
		const sessionFile = path.join(tempDir.path(), "invalid-tail.jsonl");
		await Bun.write(sessionFile, `${validTranscript("persisted-id")}\n{not valid json}\n`);
		const registry = new AgentRegistry();

		expect(
			await registerPersistedSubagent(registry, {
				id: "invalid-tail",
				displayName: "Invalid tail",
				sessionFile,
			}),
		).toBe("invalid");
		expect(registry.get("invalid-tail")).toBeUndefined();
	});

	it("requires the persisted session header to be the first entry", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-header-order-");
		const sessionFile = path.join(tempDir.path(), "late-header.jsonl");
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({
					type: "message",
					id: "before-header",
					parentId: null,
					message: { role: "user", content: "wrong order" },
				}),
				sessionHeader("persisted-id"),
				validTranscript("persisted-id").split("\n").at(1),
			].join("\n"),
		);
		const registry = new AgentRegistry();

		expect(
			await registerPersistedSubagent(registry, {
				id: "late-header",
				displayName: "Late header",
				sessionFile,
			}),
		).toBe("invalid");
		expect(registry.get("late-header")).toBeUndefined();
	});

	it("registers tombstoned external transcripts as aborted", async () => {
		using tempDir = TempDir.createSync("@omp-external-persisted-tombstone-");
		const sessionFile = path.join(tempDir.path(), "tombstoned.jsonl");
		await Bun.write(sessionFile, `${validTranscript("persisted-id")}\n`);
		await Bun.write(`${sessionFile}.tombstone`, "");
		const registry = new AgentRegistry();

		expect(
			await registerPersistedSubagent(registry, {
				id: "tombstoned",
				displayName: "Tombstoned worker",
				parentId: "Dispatch-42",
				sessionFile,
			}),
		).toBe("tombstoned");
		expect(registry.get("tombstoned")).toMatchObject({
			kind: "sub",
			parentId: "Dispatch-42",
			sessionFile,
			status: "aborted",
		});
	});
});
