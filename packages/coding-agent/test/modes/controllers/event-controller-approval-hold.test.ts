/**
 * Approval transcript hold (demo bug 6).
 *
 * The permission dialog mounts in the editor region below the transcript, so
 * while a dialog is open the transcript must not grow: any card that renders
 * after the approved diff pushes that diff off-screen and the dialog reads as
 * detached from it. The hold engages when an approval-gated call's
 * `tool_execution_start` dispatches, parks every later event FIFO, and
 * releases at that call's `tool_execution_end` (the wrapper only completes a
 * gated call after its dialog resolves), replaying the parked queue in order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const writeTool = { name: "write", approval: { tier: "write" } };

function start(toolCallId: string, toolName: string, args: Record<string, unknown> = {}): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args };
}

function end(toolCallId: string, toolName: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text" as const, text: `${toolCallId} done` }], details: {} },
		isError: false,
	};
}

function cardNames(chatContainer: TranscriptContainer): string[] {
	return chatContainer.children
		.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent)
		.map(child => {
			const text = Bun.stripANSI(child.render(120).join("\n"));
			if (/\bWrite\b/.test(text)) return "write";
			if (/\bTodo\b/.test(text)) return "todo";
			return "?";
		});
}

describe("EventController approval hold", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const chatContainer = new TranscriptContainer();
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			transcriptMessageComponents: new WeakMap(),
			pendingTools,
			chatContainer,
			session: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: true },
			showWarning: vi.fn(),
			viewSession: {
				getToolByName: (name: string) => (name === "write" ? writeTool : undefined),
				hasBuiltInTool: () => true,
			},
			sessionManager: { getCwd: () => process.cwd() },
			setTodos: vi.fn(),
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), chatContainer };
	}

	it("parks later events while a gated call's dialog is open and replays them in order on release", async () => {
		// `tools.approval.write: "prompt"` gates every write call.
		settings.set("tools.approval", { write: "prompt" });
		const { controller, chatContainer } = createFixture();

		// Gated call A: its own card renders (the dialog will mount under it)…
		await controller.handleEvent(start("tc-a", "write", { path: "a.md" }));
		expect(cardNames(chatContainer)).toEqual(["write"]);

		// …but B (gated too) and the todo call must not render until A's dialog
		// is dealt with — their starts and even B's result park FIFO.
		await controller.handleEvent(start("tc-b", "write", { path: "b.md" }));
		await controller.handleEvent(start("tc-todo", "todo", {}));
		await controller.handleEvent(end("tc-b", "write"));
		expect(cardNames(chatContainer)).toEqual(["write"]);

		// A's end releases the hold: A's result renders first, then the parked
		// queue replays in arrival order (B card, B result, todo card).
		await controller.handleEvent(end("tc-a", "write"));
		expect(cardNames(chatContainer)).toEqual(["write", "write", "todo"]);
	});

	it("renders immediately when nothing in the batch is gated", async () => {
		const { controller, chatContainer } = createFixture();
		await controller.handleEvent(start("tc-a", "todo", {}));
		await controller.handleEvent(start("tc-b", "todo", {}));
		await controller.handleEvent(start("tc-c", "write", { path: "c.md" }));
		await controller.handleEvent(end("tc-a", "todo"));
		expect(cardNames(chatContainer)).toEqual(["todo", "todo", "write"]);
	});

	it("chains the hold across consecutive gated calls, replaying each after its own dialog", async () => {
		settings.set("tools.approval", { write: "prompt" });
		const { controller, chatContainer } = createFixture();

		await controller.handleEvent(start("tc-a", "write", { path: "a.md" }));
		await controller.handleEvent(start("tc-b", "write", { path: "b.md" }));
		await controller.handleEvent(start("tc-c", "todo", {}));
		expect(cardNames(chatContainer)).toEqual(["write"]);

		// A's dialog resolves: B's card replays and re-engages the hold for its
		// own dialog, parking C until B is dealt with.
		await controller.handleEvent(end("tc-a", "write"));
		expect(cardNames(chatContainer)).toEqual(["write", "write"]);

		// B's dialog resolves: C finally renders.
		await controller.handleEvent(end("tc-b", "write"));
		expect(cardNames(chatContainer)).toEqual(["write", "write", "todo"]);
	});

	it("releases without replay when the hold is released by a bare end", async () => {
		// Prediction miss shape: the hold engaged but the call ended without
		// parking anything — later events must flow normally.
		settings.set("tools.approval", { write: "prompt" });
		const { controller, chatContainer } = createFixture();
		await controller.handleEvent(start("tc-a", "write", { path: "a.md" }));
		await controller.handleEvent(end("tc-a", "write"));
		await controller.handleEvent(start("tc-todo", "todo", {}));
		expect(cardNames(chatContainer)).toEqual(["write", "todo"]);
	});
});
