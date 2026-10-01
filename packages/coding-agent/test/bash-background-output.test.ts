import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("background bash output", () => {
	it.skipIf(process.platform === "win32")(
		"updates the display after the initiating turn ends without waking the model, then shows the failed exit",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-background-output-"));
			const manager = new AsyncJobManager({});
			const auth = createInMemoryAuthStorage();
			auth.keys.setRuntime("anthropic", "test-key");
			const late = Promise.withResolvers<void>();
			const terminal = Promise.withResolvers<void>();
			const settings = Settings.isolated({
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 10,
				"bash.direnv": "off",
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			});
			const sessionManager = SessionManager.inMemory(dir);
			let calls = 0;
			const command =
				"while [ ! -f release ]; do sleep 0.01; done; printf 'late-progress\\n'; while [ ! -f finish ]; do sleep 0.01; done; exit 3";
			const toolSession: ToolSession = {
				cwd: dir,
				hasUI: false,
				settings,
				getSessionFile: () => null,
				getSessionId: () => sessionManager.getSessionId(),
				getSessionSpawns: () => "*",
				asyncJobManager: manager,
				emitBackgroundToolUpdate: event => session.emitBackgroundToolUpdate(event),
			};
			const tool = new BashTool(toolSession);
			const mockModel = createMockModel({
				handler: () =>
					++calls === 1
						? {
								content: [
									{
										type: "toolCall",
										id: "background-output",
										name: "bash",
										arguments: { command, timeout: 10 },
									},
								],
								stopReason: "toolUse",
							}
						: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
			});
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [], tools: [tool as AgentTool], messages: [] },
				convertToLlm,
				streamFn: mockModel.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml")),
				toolRegistry: new Map([["bash", tool as AgentTool]]),
				asyncJobManager: manager,
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type !== "tool_execution_update" || event.toolCallId !== "background-output") return;
				const text =
					event.partialResult.content.find((block: { type: string; text?: string }) => block.type === "text")
						?.text ?? "";
				if (text.includes("late-progress")) late.resolve();
				if (event.partialResult.details?.async?.state === "failed") terminal.resolve();
			});
			try {
				await session.prompt("Run the command");
				const callsAtReturn = calls;
				await Bun.write(path.join(dir, "release"), "release");
				await late.promise;
				expect(calls).toBe(callsAtReturn);
				const update = session.activeToolExecutionUpdates().find(event => event.toolCallId === "background-output");
				expect(update?.partialResult.content[0].text).toContain("late-progress");
				expect(update?.partialResult.details.async.state).toBe("running");
				const lastOutputAt = update?.partialResult.details.lastOutputAt;
				expect(typeof lastOutputAt).toBe("number");
				await Bun.write(path.join(dir, "finish"), "finish");
				await terminal.promise;
				const final = session.activeToolExecutionUpdates().find(event => event.toolCallId === "background-output");
				expect(final?.partialResult.content[0].text).toContain("Command exited with code 3");
				expect(final?.partialResult.details.exitCode).toBe(3);
				expect(final?.partialResult.details.lastOutputAt).toBe(lastOutputAt);
			} finally {
				unsubscribe();
				await session.dispose();
				manager.dispose();
				auth.close();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
