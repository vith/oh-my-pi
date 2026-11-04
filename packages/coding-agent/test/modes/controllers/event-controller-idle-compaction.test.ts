import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

describe("session-owned recap UI", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("does not present a blank session recap", () => {
		const context = createInteractiveModeContext();
		const present = vi.spyOn(context, "present");
		const controller = new EventController(context);
		try {
			controller.presentIdleRecap(" \n ");
			expect(present).not.toHaveBeenCalled();
		} finally {
			controller.dispose();
		}
	});

	it("surfaces a manual recap failure as status", async () => {
		const showStatus = vi.fn();
		const context = {
			viewSession: {
				runRecap: async () => {
					throw new Error("No active model for recap");
				},
			},
			showStatus,
		} as unknown as InteractiveModeContext;
		await InteractiveMode.prototype.handleRecapCommand.call(context as unknown as InteractiveMode);
		expect(showStatus).toHaveBeenCalledWith("No active model for recap");
	});

	it("requests a manual recap from the viewed session, not the main session", async () => {
		const runRecap = vi.fn(async () => {});
		const mainRunRecap = vi.fn(async () => {});
		const context = {
			viewSession: { runRecap },
			session: { runRecap: mainRunRecap },
		} as unknown as InteractiveModeContext;
		await InteractiveMode.prototype.handleRecapCommand.call(context as unknown as InteractiveMode);
		expect(runRecap).toHaveBeenCalledTimes(1);
		expect(mainRunRecap).not.toHaveBeenCalled();
	});
});
