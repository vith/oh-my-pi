import { beforeAll, expect, it } from "bun:test";
import { TUI } from "../src/tui";
import { JobOutputOverlay } from "../src/overlays/job-output-overlay";
import { initTheme } from "../src/theme/theme";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

beforeAll(async () => {
	await initTheme(false);
});

it("scrolls fullscreen bash output with the wheel instead of snapping back to the live tail", async () => {
	const terminal = new VirtualTerminal(80, 20);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const job = {
		id: "bash-job",
		label: "build",
		status: "running",
		startTime: 1,
		output: Array.from({ length: 120 }, (_, i) => `output-row-${i + 1}`).join("\n"),
	};
	const pane = new JobOutputOverlay({
		tui,
		job,
		observe: () => ({ state: "available", job }),
		onClose: () => overlay.hide(),
	});
	const overlay = tui.showOverlay(pane, { fullscreen: true, width: "100%", maxHeight: "100%", margin: 0 });
	const screen = () =>
		terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.join("\n");
	tui.start();
	try {
		await scheduler.settle(terminal);
		expect(screen()).toContain("output-row-120");
		terminal.sendInput("\x1b[<64;5;8M");
		await scheduler.settle(terminal);
		expect(screen()).not.toContain("output-row-120");
		expect(screen()).toContain("output-row-117");
		terminal.sendInput("\x1b[<65;5;8M");
		await scheduler.settle(terminal);
		expect(screen()).toContain("output-row-120");
	} finally {
		pane.dispose();
		tui.stop();
	}
});
