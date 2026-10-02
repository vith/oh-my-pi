import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer, PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 2 (1-based y=3): the pinned expander row when the
// candidates below resolve it to the toggle sentinel.
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;

beforeAll(async () => {
	await initTheme();
});

function makeHarness(composer?: Composer) {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	let toggled = 0;
	const ctx = {
		ui: composer?.ui ?? {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => ({ top: 0, length: 5 }),
			hasOverlay: () => false,
			requestRender: () => {},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		openTranscriptScroll: (delta: -1 | 1, mode?: "prompt" | "wheel") =>
			composer?.openTranscriptScroll(delta, () => {}, mode),
		handlesBtwBranchKey: () => false,
		editor: composer?.editor ?? {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		isBashMode: false,
		isPythonMode: false,
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return {
		click: () => {
			for (const listener of listeners) listener(EXPANDER_CLICK);
		},
		focused,
		toggled: () => toggled,
	};
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		cfgTuiMouse.set(settings, true);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("scrolls captured wheel input through retained history and restores click-to-focus at the live tail", async () => {
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
		composer.ui.setInlineMouseTrackingProvider(() => cfgTuiMouse.get(settings));
		composer.editor.setText("draft preserved");
		const h = makeHarness(composer);
		composer.start({ playWelcomeIntro: false });
		const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const press = async (data: string) => {
			terminal.sendInput(data);
			await scheduler.settle(terminal);
		};
		try {
			await scheduler.settle(terminal);
			expect(screen().some(row => row.includes("HISTORY START"))).toBe(false);
			await press(`${ESC}[<64;5;3M`);
			const firstStep = screen();
			await press(`${ESC}[<64;5;3M`);
			expect(screen()[3]).toBe(firstStep[0]);
			for (let step = 0; step < 30; step++) await press(`${ESC}[<64;5;3M`);
			expect(screen().some(row => row.includes("HISTORY START"))).toBe(true);
			expect(composer.editor.getText()).toBe("draft preserved");
			for (let step = 0; step < 30 && composer.isTranscriptScrollOpen(); step++) {
				await press(`${ESC}[<65;5;3M`);
			}
			expect(composer.isTranscriptScrollOpen()).toBe(false);
			expect(screen().some(row => row.includes("HISTORY START"))).toBe(false);
			await press(`${ESC}[<0;5;${composer.ui.getMutableViewport().top + 3}M`);
			expect(h.toggled()).toBe(1);
			expect(composer.editor.getText()).toBe("draft preserved");
			await press(`${ESC}[<64;5;3M`);
			await press("x");
			expect(composer.isTranscriptScrollOpen()).toBe(false);
			expect(composer.editor.getText()).toBe("draft preservedx");
		} finally {
			composer.stop();
		}
	});
});
