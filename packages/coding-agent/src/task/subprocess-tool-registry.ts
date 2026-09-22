/**
 * Registry for handling tool events from subprocess agents.
 *
 * Tools can register handlers to:
 * - Extract structured data from their execution results
 * - Trigger subprocess termination on completion
 * - Provide custom rendering for realtime/final display
 */
import { registerSubprocessToolRenderer, type SubprocessToolRenderer } from "@oh-my-pi/pi-tui/tools/subprocess";

/** Event from subprocess tool execution (parsed from JSONL) */
export interface SubprocessToolEvent {
	toolName: string;
	toolCallId: string;
	args?: Record<string, unknown>;
	result?: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	};
	isError?: boolean;
}

/** Terminal action a subprocess-tool handler can request after a successful result. */
export type SubprocessTerminalDisposition = "terminate" | "pause";

/** Handler for subprocess tool events */
export interface SubprocessToolHandler<TData = unknown> extends SubprocessToolRenderer<TData> {
	/**
	 * Extract structured data from tool result.
	 * Extracted data is accumulated in progress.extractedToolData[toolName][].
	 */
	extractData?: (event: SubprocessToolEvent) => TData | undefined;

	/**
	 * Terminal action requested after a successful tool result. A pause stops the
	 * current turn but keeps the subprocess session available for revival.
	 */
	terminalDisposition?: (event: SubprocessToolEvent) => SubprocessTerminalDisposition | undefined;

	/**
	 * Compatibility terminal action. Return true for hard termination after the
	 * tool completes; {@link terminalDisposition} takes precedence when present.
	 */
	shouldTerminate?: (event: SubprocessToolEvent) => boolean;
}

/** Registry for subprocess tool handlers */
class SubprocessToolRegistryImpl {
	#handlers = new Map<string, SubprocessToolHandler>();

	/**
	 * Register a handler for a tool's subprocess events.
	 */
	register<T>(toolName: string, handler: SubprocessToolHandler<T>): void {
		this.#handlers.set(toolName, handler as SubprocessToolHandler);
		registerSubprocessToolRenderer(toolName, {
			renderInline: handler.renderInline,
			renderFinal: handler.renderFinal,
		});
	}

	/**
	 * Get the handler for a tool, if registered.
	 */
	getHandler(toolName: string): SubprocessToolHandler | undefined {
		return this.#handlers.get(toolName);
	}

	/**
	 * Check if a tool has a registered handler.
	 */
	hasHandler(toolName: string): boolean {
		return this.#handlers.has(toolName);
	}

	/**
	 * Get all registered tool names.
	 */
	getRegisteredTools(): string[] {
		return Array.from(this.#handlers.keys());
	}
}

/** Singleton registry instance */
export const subprocessToolRegistry = new SubprocessToolRegistryImpl();

/** Type helper for extracted tool data in progress/result */
export type ExtractedToolData = Record<string, unknown[]>;
