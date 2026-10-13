import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Supply stream metadata for tests that dispatch a complete partial snapshot. */
export function messageUpdateFromSnapshot(
	message: AssistantMessage,
): Extract<AgentSessionEvent, { type: "message_update" }> {
	const contentIndex = message.content.length - 1;
	const content = message.content[contentIndex];
	if (!content) throw new Error("A snapshot delta requires an assistant content block");

	let type: "text_delta" | "thinking_delta" | "toolcall_delta";
	let delta: string;
	switch (content.type) {
		case "text":
			type = "text_delta";
			delta = content.text;
			break;
		case "thinking":
			type = "thinking_delta";
			delta = content.thinking;
			break;
		case "toolCall":
			type = "toolcall_delta";
			delta = content[kStreamingPartialJson] ?? JSON.stringify(content.arguments);
			break;
		default:
			throw new Error(`Cannot synthesize a snapshot delta for ${content.type}`);
	}
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type, contentIndex, delta, partial: message },
	};
}
