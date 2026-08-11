/**
 * Tool wrappers for extensions.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { ComputerSafetyCheck, ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type SettingPath, Settings, type SettingValue } from "../../config/settings";
import type { Theme } from "../../modes/theme/theme";
import { type ApprovalMode, formatApprovalPrompt, truncateForPrompt } from "../../tools/approval";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { type EngineContext, type EngineDecision, evaluatePermission } from "../../tools/permissions/engine";
import { type PromptResolution, promptForDecision, renderAllowSuggestion } from "../../tools/permissions/prompt";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	declare description: string;
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;
	readonly loadMode: ToolLoadMode;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);
		this.loadMode = defaultLoadModeForToolName(registeredTool.definition.name, registeredTool.definition.loadMode);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		context?: AgentToolContext,
	) {
		// Bind the extension context to this tool's own name so `ctx.invokeTool` delegates to the
		// native built-in of the same name (present only when this tool re-registers a built-in). The
		// wrapper's own context, abort signal, and progress callback are inherited by the delegated
		// call, so a bare `ctx.invokeTool(params)` keeps the caller's `toolCall`/provider metadata
		// (write/edit LSP batching, computer safety acknowledgement), stops when the outer call is
		// aborted, and still streams native progress.
		return this.registeredTool.definition.execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			this.runner.createContext(undefined, {
				toolName: this.registeredTool.definition.name,
				context,
				signal,
				onUpdate,
			}),
		);
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

function computerSafetyChecks(context: AgentToolContext | undefined): ComputerSafetyCheck[] {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? metadata.pendingSafetyChecks : [];
}

function approvalArgs(params: unknown, context: AgentToolContext | undefined): unknown {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? { actions: metadata.actions } : params;
}

function toolEventArgs(params: unknown, context: AgentToolContext | undefined): Record<string, unknown> {
	const metadata = context?.toolCall?.providerMetadata;
	if (metadata?.type === "computer") {
		return {
			actions: metadata.actions,
			pendingSafetyChecks: metadata.pendingSafetyChecks,
		};
	}
	return params as Record<string, unknown>;
}

function approvalData(value: string): string {
	const sanitized = sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	const truncated = truncateForPrompt(sanitized, 500);
	return truncated.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function safetyCheckLines(checks: readonly ComputerSafetyCheck[]): string[] {
	return checks.map((check, index) => {
		const value = check.message || check.code || check.id;
		return `${index + 1}. ${approvalData(value)}`;
	});
}

/**
 * Settings view used when the gate's `--auto-approve` flag forces legacy yolo
 * semantics: the mode is surfaced as explicitly configured so the engine's
 * posture resolves to allow, mirroring the old gate folding `autoApprove` into
 * the approval mode. Everything else delegates to the base settings, so
 * per-tool policies, bash patterns, and rules resolve exactly as configured.
 */
function autoApproveSettings(base: Settings): Pick<Settings, "get" | "isConfigured"> {
	return {
		get: <P extends SettingPath>(path: P) =>
			(path === "tools.approvalMode" ? "yolo" : base.get(path)) as SettingValue<P>,
		isConfigured: key => key === "tools.approvalMode" || base.isConfigured(key),
	};
}

/**
 * Deny error for the approval gate. True user-policy denies keep the
 * remediation hint naming the legacy settings key; every other deny (tool
 * declarations, curated critical patterns, file rules) names the engine's
 * reason so the blocker is actionable (plan ruling, round 2). Only
 * posture-source denies (permissions.default: deny) also carry the exact
 * allow-rule YAML (spec §5.2) — a dynamic allow rule can unblock a posture
 * deny, but deny is absolute against curated/rule/tool/user layers, so a
 * suggestion there would tell the model a rule that cannot work.
 */
function blockedByPolicyError(toolName: string, decision: EngineDecision, args?: unknown): Error {
	const base =
		decision.source === "user"
			? `Tool "${toolName}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${toolName}: deny" from config.`
			: `Tool "${toolName}" is blocked: ${decision.reason ?? "denied by permission policy"}`;
	if (args !== undefined && decision.source === "posture") {
		return new Error(`${base}\n${renderAllowSuggestion(toolName, args)}`);
	}
	return new Error(base);
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Build the engine context for the approval gate. The settings view is the
	 * execute-time settings, with an isolated fallback when the context carries
	 * none; `--auto-approve` surfaces legacy yolo through `autoApproveSettings`.
	 * The cwd comes from the session manager when available so file-backed rule
	 * layers resolve against the session's project.
	 */
	#engineContext(context: AgentToolContext | undefined, settings: Settings | undefined): EngineContext {
		const base = settings ?? Settings.isolated({});
		return {
			settings: context?.autoApprove === true ? autoApproveSettings(base) : base,
			cwd: context?.sessionManager?.getCwd() ?? process.cwd(),
			home: undefined,
		};
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// The agent loop emits `tool_call` at arg-prep time (session
		// `beforeToolCall` wiring) so a handler revision lands before concurrency
		// scheduling and `tool_execution_start`. Consume the marker
		// unconditionally so it cannot go stale; emit here only for dispatches
		// the loop never saw — nested xd:// device dispatches and direct
		// (non-loop) execution such as Cursor exec handlers.
		const loopEmittedToolCall = this.runner.consumeToolCallEmitted(toolCallId, this.tool.name);
		// Resolve approval settings up front. A `deny` on the original input short-circuits before the
		// runner is touched — an already-denied tool never emits `tool_call` — while the full gate below
		// re-resolves against the (possibly revised) input so a handler cannot rewrite into a denied or
		// newly prompt-gated command and have it run unapproved.
		const cliAutoApprove = context?.autoApprove === true;
		const settings: Settings | undefined = context?.settings;
		const configuredMode = (settings?.get("tools.approvalMode") ?? "yolo") as ApprovalMode;
		const approvalMode: ApprovalMode = cliAutoApprove ? "yolo" : configuredMode;
		const engineCtx = this.#engineContext(context, settings);
		const shortCircuit = evaluatePermission(this.tool, approvalArgs(params, context), engineCtx);
		if (shortCircuit.policy === "deny") {
			throw blockedByPolicyError(this.tool.name, shortCircuit, approvalArgs(params, context));
		}

		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with. Doing this BEFORE the approval gate means approval (below) resolves against the
		// input that actually executes, closing the "approve one thing, run another" gap: the prompt
		// text, policy resolution, and provider safety checks all see `effectiveParams`.
		let effectiveParams = params;
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, toolEventArgs(params, context)),
					),
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
				// A non-blocking handler may replace the execution input. The returned object is the raw
				// input passed to `execute` (handler-owned; not re-normalized). Skipped for `computer`
				// tool calls, whose event input is a synthetic {actions,pendingSafetyChecks} view
				// (see toolEventArgs) rather than the real execution params.
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as typeof params;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}

		// 2. Full approval gate against the (possibly revised) input that will actually run — resolves
		// policy and prompts on `effectiveParams`, so the user approves exactly what executes. A revised
		// input that newly resolves to `deny` is caught here even though the original passed the
		// short-circuit above.
		const resolvedArgs = approvalArgs(effectiveParams, context);
		const decision = evaluatePermission(this.tool, resolvedArgs, engineCtx);
		context?.xdevTierResolved?.(decision.tier);
		if (decision.policy === "deny") {
			throw blockedByPolicyError(this.tool.name, decision, resolvedArgs);
		}
		const pendingSafetyChecks = computerSafetyChecks(context);
		// An xd:// device dispatch already cleared the write tool's outer gate at
		// this tool's tier — re-prompting would double-ask for one action. The
		// bypass only holds while the input is exactly what that outer gate
		// approved: a handler revision here may have raised the tier, so revised
		// input always faces the full gate. Tool-declared and per-tool user
		// "prompt" decisions and tool-demanded overrides still prompt. Provider
		// safety checks are stronger: yolo, per-tool allow, and xdev approval
		// never acknowledge them on the user's behalf.
		const xdevBypass = context?.xdevApproved === true && effectiveParams === params;
		const approvalCheck = {
			required:
				pendingSafetyChecks.length > 0 ||
				(decision.policy === "prompt" &&
					(decision.source === "tool" || decision.source === "user" || decision.override || !xdevBypass)),
			reason: decision.reason,
		};

		if (approvalCheck.required) {
			const hasApprovalHandlers =
				this.runner.hasHandlers("tool_approval_requested") || this.runner.hasHandlers("tool_approval_resolved");
			const sessionId = context?.sessionManager?.getSessionId() ?? "";
			if (hasApprovalHandlers) {
				await this.runner.emit({
					type: "tool_approval_requested",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					...(approvalCheck.reason ? { reason: approvalCheck.reason } : {}),
					approvalMode,
				});
			}

			const emitApprovalResolved = async (approved: boolean, reason?: string) => {
				if (!hasApprovalHandlers) return;
				await this.runner.emit({
					type: "tool_approval_resolved",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					approved,
					...(reason ? { reason } : {}),
				});
			};

			// Provider safety checks fail closed without an interactive prompt. Unlike
			// ordinary tier approval, no setting or yolo mode may bypass this gate.
			if (!this.runner.hasUI()) {
				const reason = "no interactive UI available";
				await emitApprovalResolved(false, reason);
				if (pendingSafetyChecks.length > 0) {
					throw new Error(
						`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,
					);
				}
				throw new Error(
					`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
						`Options:\n` +
						`  1. Set tools.approvalMode: yolo in /settings\n` +
						`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
						`  3. Use an interactive UI to approve the tool call`,
				);
			}

			const uiContext = this.runner.getUIContext();
			const basePrompt = formatApprovalPrompt(this.tool, resolvedArgs, approvalCheck.reason);
			const safetyPrompt =
				pendingSafetyChecks.length > 0
					? `${basePrompt}\nProvider safety checks:\n${safetyCheckLines(pendingSafetyChecks).join("\n")}`
					: basePrompt;
			let resolution: PromptResolution;
			try {
				resolution = await promptForDecision(uiContext, this.tool.name, resolvedArgs, decision, engineCtx, {
					title: safetyPrompt,
					// Provider safety checks are stronger than any rule: the dialog
					// shows without candidates and only offers Approve/Deny.
					includeCandidates: pendingSafetyChecks.length === 0,
				});
			} catch (err) {
				await emitApprovalResolved(false, err instanceof Error ? err.message : "approval aborted");
				throw err;
			}
			await emitApprovalResolved(
				resolution.policy === "allow",
				resolution.policy === "deny" ? "denied by user" : undefined,
			);
			if (resolution.policy === "deny") {
				throw new Error(`Tool call denied by user: ${this.tool.name}`);
			}
			if (pendingSafetyChecks.length > 0) {
				if (!context) throw new Error("Provider safety approval context is unavailable");
				context.providerSafetyApproved = true;
			}
		}

		// Execute the actual tool
		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: normalizeToolEventInput(
					this.tool.name,
					resolveToolEventInput(this.tool, toolEventArgs(effectiveParams, context)),
				),
				content: result.content,
				details: result.details,
				isError: !!executionError,
			});

			if (resultResult) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Effective error state: an explicit handler override wins; otherwise the
				// original execution outcome stands. This lets a handler rewrite a failed
				// call's model-visible content/details while keeping it an error, flip a
				// failure to success, or flag a success as an error.
				const effectiveError = resultResult.isError ?? !!executionError;

				// Return the (possibly modified) result carrying the error flag rather than
				// rethrowing the original exception. The agent loop honors
				// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
				// `coerceToolResult` in agent-loop), so replacement failure content reaches
				// the model while the call remains an error — the original exception text is
				// no longer forced through, which previously discarded the replacement.
				return {
					content: modifiedContent,
					details: modifiedDetails,
					providerMetadata: result.providerMetadata,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		// No extension modification
		if (executionError) {
			throw executionError;
		}
		return result;
	}
}
