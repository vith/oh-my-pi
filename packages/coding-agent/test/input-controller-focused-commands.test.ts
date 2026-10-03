/**
 * Focused subagent views are chat-only, except for viewer-scoped commands: `/btw`
 * asks a side question about the focused transcript, `/export` writes the focused
 * agent's own transcript (with its nested subagents), `/jobs follow` opens its bash
 * output, and `/usage` reports account-wide limits. Everything else still requires
 * returning to main.
 *
 * Failure mode if this regresses: these commands silently do nothing (or steer the
 * agent) in a focused view, or `/export` writes the main session instead of the viewed one.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";

beforeAll(async () => {
	await initTheme(false);
});

function createFocusedContext() {
	let editorText = "";
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		imageLinks: undefined,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft: vi.fn(),
	};
	const prompt = vi.fn(async () => {});
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: false,
			isCompacting: false,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
		},
		viewSession: { isStreaming: false, queuedMessageCount: 0, prompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		collabGuest: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		handleUsageCommand: vi.fn(async () => {}),
		handleExportCommand: vi.fn(async () => {}),
		handleBtwCommand: vi.fn(async () => {}),
		showResetUsageSelector: vi.fn(async () => {}),
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	};
	return { ctx: ctx as unknown as InteractiveModeContext, raw: ctx, editor, prompt };
}

async function submit(text: string) {
	const focused = createFocusedContext();
	const controller = new InputController(focused.ctx);
	controller.setupEditorSubmitHandler();
	focused.editor.setText(text);
	await focused.ctx.editor.onSubmit?.(text);
	return focused;
}

describe("focused subagent view slash commands", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs /usage from the focused view", async () => {
		const { raw, prompt } = await submit("/usage");
		expect(raw.handleUsageCommand).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /export with its arguments from the focused view", async () => {
		const { raw, prompt } = await submit("/export out.html");
		expect(raw.handleExportCommand).toHaveBeenCalledWith("/export out.html");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /btw with its question from the focused view instead of steering the agent", async () => {
		const { raw, prompt } = await submit("/btw what is it doing?");
		expect(raw.handleBtwCommand).toHaveBeenCalledWith("what is it doing?");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("opens the focused session's bash output without steering the agent", async () => {
		const focused = createFocusedContext();
		const terminal = new VirtualTerminal(100, 38);
		const scheduler = new VirtualRenderScheduler();
		const ui = new TUI(terminal, false, { renderScheduler: scheduler });
		const job = {
			id: "bg_1",
			type: "bash",
			status: "running",
			label: "worker build",
			startTime: Date.now(),
			output: "output from the focused worker",
		};
		const ctx = {
			...focused.raw,
			ui,
			session: {
				...focused.raw.session,
				getAsyncJobSnapshot: () => ({
					running: [{ ...job, output: "output from the main session" }],
					recent: [],
				}),
			},
			viewSession: {
				...focused.raw.viewSession,
				sessionId: "Worker",
				getAsyncJobSnapshot: () => ({ running: [job], recent: [] }),
			},
			handleJobsCommand: (args: string) => commands.handleJobsCommand(args),
		} as unknown as InteractiveModeContext;
		const commands = new CommandController(ctx);
		const input = new InputController(ctx);
		input.setupEditorSubmitHandler();
		focused.editor.setText("/jobs follow bg_1");
		ui.start();
		try {
			await ctx.editor.onSubmit?.("/jobs follow bg_1");
			await scheduler.settle(terminal);
			const screen = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(ui.hasOverlay()).toBe(true);
			expect(screen).toContain("output from the focused worker");
			expect(screen).not.toContain("output from the main session");
			expect(focused.prompt).not.toHaveBeenCalled();
		} finally {
			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			ui.stop();
		}
	});

	it("keeps other jobs forms gated to the main session", async () => {
		const { editor, prompt } = await submit("/jobs");
		expect(editor.getText()).toBe("/jobs");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps other commands gated to the main session, draft intact", async () => {
		const { editor, prompt } = await submit("/compact");
		expect(editor.getText()).toBe("/compact");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps the mutating /usage reset form gated to the main session", async () => {
		for (const text of ["/usage reset", "/usage reset anthropic/active"]) {
			const { raw, editor } = await submit(text);
			expect(raw.showResetUsageSelector).not.toHaveBeenCalled();
			expect(raw.handleUsageCommand).not.toHaveBeenCalled();
			expect(editor.getText()).toBe(text);
		}
	});

	it("exports the viewed (focused) session rather than the main session", async () => {
		const mainExport = vi.fn(async () => "main.html");
		const viewExport = vi.fn(async () => "worker.html");
		const showStatus = vi.fn();
		const ctx = {
			session: { exportToHtml: mainExport },
			viewSession: { exportToHtml: viewExport },
			showStatus,
			showError: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

		await controller.handleExportCommand("/export");

		expect(viewExport).toHaveBeenCalledTimes(1);
		expect(mainExport).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session exported to: worker.html");
	});
});
