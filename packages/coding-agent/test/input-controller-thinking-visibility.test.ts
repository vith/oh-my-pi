import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

beforeAll(async () => {
	await initTheme(false);
});

function createAssistant(): AssistantMessageComponent {
	const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
	assistant.setHideThinkingBlock = vi.fn();
	return assistant;
}

describe("InputController thinking visibility", () => {
	it("keeps live elapsed time and provider update age advancing after a visibility toggle", () => {
		let now = 1000;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
		const assistant = new AssistantMessageComponent(undefined, false);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const ctx = {
			hideThinkingBlock: false,
			hasDisplayableThinkingContent: true,
			settings: Settings.isolated(),
			session: { thinkingLevel: "high" },
			chatContainer: { children: [assistant], resetStableEmission: vi.fn() },
			streamingComponent: assistant,
			streamingMessage: message,
			showStatus: vi.fn(),
			ui: { resetDisplay: vi.fn() },
		} as unknown as InteractiveModeContext;
		try {
			assistant.updateContent(message, {
				transient: true,
				streamUpdatedAt: now,
				streamUpdateNumber: 7,
				streamUpdateType: "thinking_start",
				streamUpdateContentIndex: 0,
			});
			now = 4000;
			new InputController(ctx).toggleThinkingBlockVisibility();
			now = 9000;
			// Refresh the cached ANSI pulse without introducing another provider update.
			assistant.invalidate();
			const frame = Bun.stripANSI(assistant.render(160).join("\n"));
			expect(frame).toContain("8.0s elapsed");
			expect(frame).toContain("#7: reasoning item started");
			expect(frame).toContain("8.0s ago");
			expect(frame).not.toContain("Thought for");
		} finally {
			assistant.dispose();
			nowSpy.mockRestore();
		}
	});

	it("refuses to toggle and informs the user when thinking level is off", () => {
		// When thinking is "off", effectiveHideThinkingBlock is true even if the
		// user's hideThinkingBlock setting is false. The toggle should refuse
		// instead of silently no-op'ing or corrupting the setting.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		// Setting was not changed, components were not updated, no reset.
		expect(ctx.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("allows toggling when thinking is off after reasoning content was received", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetOrder: string[] = [];
		const resetDisplay = vi.fn(() => resetOrder.push("display"));
		const resetStableEmission = vi.fn(() => resetOrder.push("stable emission"));
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: false,
			hasDisplayableThinkingContent: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: {
				children: [assistant],
				clear: vi.fn(),
				addChild: vi.fn(),
				resetStableEmission,
			},
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(resetOrder).toEqual(["stable emission", "display"]);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});

	it("refuses to toggle when the focused view session has thinking off", () => {
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: false,
			effectiveHideThinkingBlock: true,
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "high" },
			viewSession: { thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.isConfigured(settings)).toBe(false);
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("refuses to toggle when thinking is off even if hideThinkingBlock is already true", () => {
		// The persisted preference may already be true from a prior session
		// where thinking was on. With thinking off, effectiveHideThinkingBlock
		// is true regardless, so any toggle is a no-op — guard it rather than
		// flipping the persisted preference back to false.
		const assistant = createAssistant();
		const setHideThinkingBlock = assistant.setHideThinkingBlock as Mock<(hidden: boolean) => void>;
		const settings = Settings.isolated();
		cfgHideThinkingBlock.set(settings, true);
		const showStatus = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideThinkingBlock: true,
			effectiveHideThinkingBlock: true, // thinking is off → effective is true
			settings,
			session: { agent: { hideThinkingSummary: false }, thinkingLevel: "off" },
			chatContainer: { children: [assistant], clear: vi.fn(), addChild: vi.fn() },
			streamingComponent: undefined,
			streamingMessage: undefined,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		// Persisted preference unchanged, no component updates, no reset.
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(setHideThinkingBlock).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});
});
