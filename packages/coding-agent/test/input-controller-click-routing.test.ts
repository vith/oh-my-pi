import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const ESC = String.fromCharCode(27);

beforeAll(async () => {
	await initTheme();
});

function makeHarness(composer: Composer): void {
	const ctx = {
		ui: composer.ui,
		handlesBtwBranchKey: () => false,
		editor: composer.editor,
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		isBashMode: false,
		isPythonMode: false,
		session: {
			extensionRunner: undefined,
		},
		focusedAgentId: undefined,
		openTranscriptScroll: (delta: -1 | 1) => composer.openTranscriptScroll(delta, () => {}, "page"),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
}

describe("main transcript scrolling", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("pages the transcript from the live prompt while preserving the draft and leaving wheel input alone", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: {
				quiet: true,
				spellingTypoDetection: false,
				spellingAutocomplete: "off",
				spellingAutocorrect: false,
			},
		});
		composer.setHeaderExtras([], [new Text("HISTORY START", 0, 0)]);
		const transcript = new TranscriptContainer();
		for (let turn = 1; turn <= 4; turn++) {
			transcript.addChild(new UserMessageComponent(`prompt ${turn}`));
			transcript.addChild(new Text(Array.from({ length: 8 }, (_, row) => `answer ${turn}.${row}`).join("\n"), 0, 0));
		}
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.editor.setText("draft preserved");
		makeHarness(composer);
		composer.start({ playWelcomeIntro: false });
		const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const press = async (data: string) => {
			terminal.sendInput(data);
			await scheduler.settle(terminal);
		};
		try {
			await scheduler.settle(terminal);
			expect(screen().some(row => row.includes("HISTORY START"))).toBe(false);
			const before = screen();
			// The first Page Up must leave the live tail without a preceding wheel event.
			await press(`${ESC}[5~`);
			expect(composer.ui.hasOverlay()).toBe(true);
			expect(screen().some(row => row.includes("answer 2.0"))).toBe(true);
			expect(screen().some(row => row.includes("answer 4.7"))).toBe(false);
			expect(composer.editor.getText()).toBe("draft preserved");
			await press(`${ESC}[5~`);
			expect(screen().some(row => row.includes("HISTORY START"))).toBe(true);
			for (let page = 0; page < 10 && composer.ui.hasOverlay(); page++) await press(`${ESC}[6~`);
			expect(composer.ui.hasOverlay()).toBe(false);
			expect(screen()).toEqual(before);
			// Empty drafts used to swallow the page keys too.
			composer.editor.setText("");
			await press(`${ESC}[5~`);
			expect(screen().some(row => row.includes("answer 2.0"))).toBe(true);
			await press("x");
			expect(composer.ui.hasOverlay()).toBe(false);
			expect(composer.editor.getText()).toBe("x");
			composer.editor.setText("draft preserved");
			await scheduler.settle(terminal);

			for (const input of [`${ESC}[<64;5;3M`, `${ESC}[<65;5;3M`, `${ESC}[1;5A`, `${ESC}[1;5B`]) {
				await press(input);
				expect(composer.ui.hasOverlay()).toBe(false);
				expect(screen()).toEqual(before);
				expect(composer.editor.getText()).toBe("draft preserved");
			}
			await press("x");
			expect(composer.editor.getText()).toBe("draft preservedx");
		} finally {
			composer.stop();
		}
	});
});
