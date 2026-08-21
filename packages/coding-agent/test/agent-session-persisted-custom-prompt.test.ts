import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession persisted custom prompt", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.[Symbol.dispose]();
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
	});

	it("flushes a persisted custom prompt before the provider observes it without duplicating its entry", async () => {
		tempDir = TempDir.createSync("@pi-persisted-custom-prompt-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendSessionInit({ systemPrompt: "test", task: "test", tools: [] });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const providerStarted = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		let transcriptAtProviderStart = "";
		const mock = createMockModel({
			handler: async () => {
				transcriptAtProviderStart = await Bun.file(sessionFile).text();
				providerStarted.resolve();
				await releaseProvider.promise;
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const turn = session.promptCustomMessagePersisted({
			customType: "subagent-durable-follow-up",
			content: "Use port 8080.",
			display: true,
			details: { deliveryKey: "resolution:r1" },
			attribution: "user",
		});
		await providerStarted.promise;

		expect(transcriptAtProviderStart.match(/resolution:r1/g)).toHaveLength(1);
		releaseProvider.resolve();
		await turn;
		await sessionManager.flush();
		expect((await Bun.file(sessionFile).text()).match(/resolution:r1/g)).toHaveLength(1);
		await sessionManager.close();
	});
});
