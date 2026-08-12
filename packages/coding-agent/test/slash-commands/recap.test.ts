import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleRecapCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleRecapCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleRecapCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/recap slash command", () => {
	it("triggers the on-demand recap through the interactive handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/recap", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleRecapCommand).toHaveBeenCalledTimes(1);
	});

	it("takes no arguments", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/recap now", harness.runtime);

		expect(handled).toBe(false);
		expect(harness.handleRecapCommand).not.toHaveBeenCalled();
	});
});
