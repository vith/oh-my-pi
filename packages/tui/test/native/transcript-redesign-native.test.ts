import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	setTranscriptActionHandler(undefined);
	harness?.stop();
	harness = undefined;
});

const USAGE: AssistantMessage["usage"] = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failed(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		usage: USAGE,
		timestamp: 1,
	};
}

/** A node's prop by name, whatever its kind. */
function prop(node: TspNode | undefined, name: string): unknown {
	const props = node?.p;
	for (const key in props) if (key === name) return props[key as keyof typeof props];
	return undefined;
}

function texts(node: TspNode | undefined): string {
	if (!node) return "";
	const own = prop(node, "text");
	const spans = prop(node, "spans");
	return (
		(typeof own === "string" ? own : "") +
		(Array.isArray(spans) ? (spans as { t: string }[]).map(s => s.t).join("") : "") +
		(node.c ?? []).map(texts).join("")
	);
}

describe("native transcript redesign", () => {
	it("draws a failed request as one frame: status chip, the message once, actions that run omp's commands", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const component = new AssistantMessageComponent(
			failed("500 upstream overloaded\nupstream overloaded (type=server_error)"),
		);
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();

		const frame = harness.find(node => node.k === "card" && node.p?.role === "omp.error");
		expect(frame?.p).toMatchObject({ tone: "error" });
		expect(harness.find(node => node.k === "badge" && node.p?.role === "omp.error.code")?.p).toMatchObject({
			text: "500",
		});
		const message = harness.find(node => node.p?.role === "omp.error.message");
		expect(texts(message)).toBe("upstream overloaded (type=server_error)");

		const retry = harness.find(node => node.p?.role === "omp.error.action" && texts(node).startsWith("Retry"));
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: retry!.id, act: "retry" });
		const copy = harness.find(node => node.p?.role === "omp.error.action" && texts(node).startsWith("Copy"));
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: copy!.id, act: "copy-error" });
		expect(actions).toEqual([{ act: "retry" }, { act: "copy", text: "upstream overloaded (type=server_error)" }]);
		expect(harness.errors).toEqual([]);
	});

	it("streams thinking under a live head, then settles to a collapsed 'Thought' line", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		const thinking = (text: string): AssistantMessage => ({
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: text }],
		});
		component.updateContent(thinking("Weighing it"), { transient: true });
		await harness.render();
		const live = harness.find(node => node.k === "section" && node.p?.role === "omp.thinking.live");
		expect(live).toBeDefined();
		expect(harness.find(node => node.k === "spinner" && node.p?.style === "starburst")).toBeDefined();
		expect(harness.find(node => node.k === "elapsed")).toBeDefined();
		expect(prop(live, "took")).toBeUndefined();

		component.updateContent(thinking("Weighing it carefully"));
		component.markTranscriptBlockFinalized();
		await harness.render();
		const done = harness.find(node => node.k === "section" && node.p?.role === "omp.thinking");
		expect(done?.p).toMatchObject({ collapsed: true });
		expect(texts(done)).toStartWith("Thought");
		expect(prop(done, "took")).toBeNumber();
		expect(harness.find(node => node.k === "spinner")).toBeUndefined();
		expect(harness.errors).toEqual([]);
	});

	it("shows summary-less reasoning with provider-update age, resets on incoming activity, then yields to the answer", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		const nowSpy = vi.spyOn(performance, "now");
		let now = 6000;
		nowSpy.mockImplementation(() => now);
		const message: AssistantMessage = {
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: "" }],
		};
		try {
			component.updateContent(message, {
				transient: true,
				streamUpdatedAt: 1000,
				streamUpdateNumber: 1,
				streamUpdateType: "thinking_start",
			});
			await harness.render();
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 5000)).toBeDefined();
			expect(harness.find(node => node.k === "spinner")?.p).toMatchObject({ style: "starburst" });
			expect(harness.find(node => node.k === "rate")).toBeUndefined();
			expect(harness.find(node => /#1:.*reasoning.*started/.test(JSON.stringify(node.p ?? {})))).toBeDefined();

			now = 7000;
			component.invalidate();
			await harness.render();
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 6000)).toBeDefined();

			component.updateContent(message, {
				transient: true,
				streamUpdatedAt: now,
				streamUpdateNumber: 2,
				streamUpdateType: "thinking_end",
			});
			await harness.render();
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 0)).toBeDefined();
			expect(harness.find(node => /#2:.*reasoning.*completed/.test(JSON.stringify(node.p ?? {})))).toBeDefined();

			component.updateContent({
				...message,
				content: [...message.content, { type: "text", text: "The answer" }],
			});
			component.markTranscriptBlockFinalized();
			await harness.render();
			expect(harness.find(node => node.k === "spinner")).toBeUndefined();
			expect(harness.find(node => node.k === "elapsed")).toBeUndefined();
			expect(harness.find(node => node.k === "md")?.p).toMatchObject({ text: "The answer" });
			expect(harness.errors).toEqual([]);
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});

	it("retains each completed summary-less thinking duration through later items and finalization", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		let now = 1000;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
		let message: AssistantMessage = {
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: "" }],
		};
		let number = 0;
		const update = async (type: "thinking_start" | "thinking_end", index: number) => {
			component.updateContent(message, {
				transient: true,
				streamUpdatedAt: now,
				streamUpdateNumber: ++number,
				streamUpdateType: type,
				streamUpdateContentIndex: index,
			});
			await harness!.render();
		};
		try {
			await update("thinking_start", 0);
			now = 6000;
			await update("thinking_end", 0);
			expect(harness.find(node => node.k === "elapsed" && node.p?.stopped === 5000)).toBeDefined();
			now = 10000;
			message = { ...message, content: [...message.content, { type: "thinking", thinking: "" }] };
			await update("thinking_start", 1);
			expect(harness.find(node => /Thought.*5s/.test(texts(node)))).toBeDefined();

			now = 12000;
			await update("thinking_start", 1);
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 2000)).toBeDefined();
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 0)).toBeDefined();

			now = 14000;
			await update("thinking_end", 1);
			now = 20000;
			message = { ...message, content: [...message.content, { type: "thinking", thinking: "" }] };
			await update("thinking_start", 2);
			expect(harness.find(node => /Thought.*5s/.test(texts(node)))).toBeDefined();
			expect(harness.find(node => /Thought.*4s/.test(texts(node)))).toBeDefined();
			expect(harness.errors).toEqual([]);

			now = 23000;
			component.updateContent({ ...message, content: [...message.content, { type: "text", text: "Answer" }] });
			component.markTranscriptBlockFinalized();
			await harness.render();
			expect(harness.find(node => /Thought.*5s/.test(texts(node)))).toBeDefined();
			expect(harness.find(node => /Thought.*4s/.test(texts(node)))).toBeDefined();
			expect(harness.find(node => /Thought.*3s/.test(texts(node)))).toBeDefined();
			expect(harness.find(node => node.k === "elapsed")).toBeUndefined();
			expect(harness.errors).toEqual([]);
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});

	it("does not invent a duration for an item first observed at explicit completion", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		let now = 1000;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
		const message: AssistantMessage = {
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: "" }],
		};
		try {
			component.updateContent(message, {
				transient: true,
				streamUpdatedAt: now,
				streamUpdateType: "thinking_end",
				streamUpdateContentIndex: 0,
			});
			now = 6000;
			component.invalidate();
			component.updateContent(message, { transient: true });
			await harness.render();
			// Only provider update age has an elapsed node; the unobserved
			// reasoning item has neither a live clock nor a stopped clock.
			expect(harness.find(node => node.k === "elapsed" && node.p?.age === 5000)).toBeDefined();
			expect(harness.find(node => node.k === "elapsed" && node.p?.age !== 5000)).toBeUndefined();
			expect(harness.find(node => node.k === "elapsed" && node.p?.stopped !== undefined)).toBeUndefined();
			now = 9000;
			component.markTranscriptBlockFinalized();
			await harness.render();
			expect(harness.find(node => node.k === "elapsed")).toBeUndefined();
			expect(harness.find(node => /Thought.*for/.test(texts(node)))).toBeUndefined();
			expect(harness.errors).toEqual([]);
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});

	it("closes the indexed older item without stopping newer thinking or extending duplicate completions", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		let now = 1000;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
		let message: AssistantMessage = {
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: "" }],
		};
		const update = async (type: "thinking_start" | "thinking_end", index: number) => {
			component.updateContent(message, {
				transient: true,
				streamUpdatedAt: now,
				streamUpdateType: type,
				streamUpdateContentIndex: index,
			});
			await harness!.render();
		};
		try {
			await update("thinking_start", 0);
			now = 3000;
			message = { ...message, content: [...message.content, { type: "thinking", thinking: "" }] };
			await update("thinking_start", 1);
			now = 4000;
			await update("thinking_end", 0);
			expect(harness.find(node => /Thought.*3s/.test(texts(node)))).toBeDefined();
			expect(
				harness.find(node => node.k === "elapsed" && node.p?.age === 1000 && node.p.stopped === undefined),
			).toBeDefined();

			now = 5000;
			await update("thinking_end", 0);
			expect(harness.find(node => /Thought.*3s/.test(texts(node)))).toBeDefined();
			expect(
				harness.find(node => node.k === "elapsed" && node.p?.age === 2000 && node.p.stopped === undefined),
			).toBeDefined();
			expect(harness.errors).toEqual([]);
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});

	it("gives a user message no head row, and routes its toolbar to omp's copy and rewind", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const user = new UserMessageComponent("Fix the build", { timestamp: Date.UTC(2026, 0, 1, 12, 30) });
		harness = await TspHarness.start();
		harness.tui.addChild(user);
		await harness.render();
		const frame = harness.find(node => node.k === "card" && node.p?.role === "omp.user");
		expect(prop(frame, "head")).toBeUndefined();
		const tool = (label: string) =>
			harness!.find(node => node.p?.role === "omp.user.tool" && prop(node, "text") === label)!;
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: tool("Copy").id, act: "copy-message" });
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: tool("Rewind").id, act: "rewind" });
		expect(actions).toEqual([{ act: "copy", text: "Fix the build" }, { act: "rewind" }]);
	});

	it("shows a status notice as a toast that re-shows when its text changes", async () => {
		const notice = new StatusNotice("Thinking blocks: hidden");
		harness = await TspHarness.start();
		harness.tui.addChild(notice);
		await harness.render();
		const toast = harness.find(node => node.k === "toast");
		expect(toast?.p).toMatchObject({ text: "Thinking blocks: hidden", ttl: 2400 });
		notice.setMessage("Thinking blocks: shown");
		harness.tui.requestRender();
		await harness.render();
		expect(harness.find(node => node.k === "toast")?.p).toMatchObject({ text: "Thinking blocks: shown" });
		expect(harness.find(node => node.k === "text" && node.p?.text === "Thinking blocks: hidden")).toBeUndefined();
	});
});
