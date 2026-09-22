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
import { logger, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { type SettingPath, Settings, type SettingValue } from "../../config/settings";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { type ApprovalMode, formatApprovalPrompt, truncateForPrompt } from "../../tools/approval";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { withFileMutationSession } from "../../tools/file-write-fallback";
import { type AuditRecord, appendAudit, auditFilePath } from "../../tools/permissions/audit";
import { type EngineContext, type EngineDecision, evaluatePermission } from "../../tools/permissions/engine";
import { type PromptResolution, promptForDecision, renderAllowSuggestion } from "../../tools/permissions/prompt";
import { abortPendingForSession, type PendingApproval, parkApproval } from "../../tools/permissions/subagent";
import { createSuggestionProvider } from "../../tools/permissions/suggest";
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
 * reason so the blocker is actionable (plan ruling, round 2). Rule-source
 * denies (spec §5.2) and posture-source denies (permissions.default: deny)
 * also carry the allow suggestion: an allow that strictly beats the deciding
 * deny by class then specificity (deny wins ties) renders its exact YAML, a
 * deny nothing beats renders the dead end, and a posture deny suggests the
 * first allow candidate (a dynamic allow beats the default posture). Tool/
 * curated denies stay suggestion-free: they are absolute.
 */
function blockedByPolicyError(
	toolName: string,
	decision: EngineDecision,
	args: unknown,
	engineCtx: EngineContext,
): Error {
	const base =
		decision.source === "user"
			? `Tool "${toolName}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${toolName}: deny" from config.`
			: `Tool "${toolName}" is blocked: ${decision.reason ?? "denied by permission policy"}`;
	// Bash tool-declared denies short-circuit the engine walk's source to
	// "tool" (the tool approval re-emits the engine decision), so a bash rule
	// deny only re-opens the gate via its ruleId. Curated hard-denies carry no
	// ruleId and stay suggestion-free, as do tool/user-source denies. The
	// suggestion judges the DENIED PIECE, not the whole compound command:
	// piece-level allow overrides only match their own piece text.
	const deniedPiece = decision.pieces?.find(piece => piece.policy === "deny");
	const bashRuleDeny = toolName === "bash" && decision.ruleId !== undefined;
	if (args !== undefined && (decision.source === "posture" || decision.source === "rule" || bashRuleDeny)) {
		const suggestionArgs =
			deniedPiece !== undefined && toolName === "bash"
				? { ...(args as Record<string, unknown>), command: deniedPiece.text }
				: args;
		return new Error(`${base}\n${renderAllowSuggestion(toolName, suggestionArgs, engineCtx)}`);
	}
	return new Error(base);
}

/** Audit failures are silent; the first one per process logs a warning. */
let auditWarned = false;

/** The command under evaluation, when the call carries one (bash). */
function auditCommand(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const command = (args as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

/**
 * Race a parked approval against the tool call's abort signal (spec §6.3): an
 * aborted call must settle the parked promise instead of blocking forever.
 * Aborting also drops every pending of the session — the agent that parked
 * them is going down, so no parked call may outlive it (the session-level
 * abort path, AgentSession.abort → abortPendingForSession, settles them too;
 * this covers the signal firing on its own). The listener is removed on
 * every settle path so nothing leaks.
 */
function raceParkedApproval(
	parked: Promise<{ policy: "allow" | "deny" }>,
	signal: AbortSignal | undefined,
	sessionId: string,
	toolName: string,
): Promise<{ policy: "allow" | "deny" }> {
	if (signal === undefined) return parked;
	const abortError = () =>
		new Error(`Approval for tool "${toolName}" aborted: the tool call was aborted before it could be answered`);
	if (signal.aborted) {
		abortPendingForSession(sessionId);
		return Promise.reject(abortError());
	}
	const { promise, resolve, reject } = Promise.withResolvers<{ policy: "allow" | "deny" }>();
	const onAbort = () => {
		signal.removeEventListener("abort", onAbort);
		abortPendingForSession(sessionId);
		reject(abortError());
	};
	const settle = (resolution: { policy: "allow" | "deny" }) => {
		signal.removeEventListener("abort", onAbort);
		resolve(resolution);
	};
	const fail = (err: unknown) => {
		signal.removeEventListener("abort", onAbort);
		reject(err instanceof Error ? err : new Error(String(err)));
	};
	parked.then(settle, fail);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
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
		// A context-less execute carries no settings at all. The gate's own mode
		// default for that path is legacy yolo (`settings?.get(...) ?? "yolo"`),
		// so surface the mode as explicitly configured exactly like the
		// auto-approve view — an empty isolated fallback would resolve the new
		// unconfigured "prompt" posture and gate headless dispatches the old
		// wrapper auto-approved. Sessions (settings present) keep the new
		// default posture.
		const base = settings ?? Settings.isolated({});
		return {
			settings: context?.autoApprove === true || settings === undefined ? autoApproveSettings(base) : base,
			cwd: context?.sessionManager?.getCwd() ?? process.cwd(),
			home: context?.home,
			// Resolves the in-memory session rule layer ("Allow for this session").
			sessionId: context?.sessionManager?.getSessionId(),
		};
	}

	/**
	 * Persist the engine's final decision for this call into the audit log
	 * (spec §7). Runs at the final decision point only: gate-time denies
	 * record before execute, allowed calls record after execute with the
	 * execution outcome. Guarded by `permissions.audit.enabled`; a session
	 * manager is required because the log lives under the session cwd — the
	 * production loop always provides one, and without it there is no
	 * meaningful file target (the rule engine's `process.cwd()` fallback is
	 * in-memory only; a persisted log must not scatter into arbitrary
	 * working directories). Failures are silent — the tool call never
	 * breaks because the log is unwritable (warned once).
	 */
	async #recordAudit(
		decision: EngineDecision,
		args: unknown,
		outcome: "executed" | "blocked" | "error",
		context: AgentToolContext | undefined,
		engineCtx: EngineContext,
	): Promise<void> {
		if (!context?.sessionManager) return;
		if (engineCtx.settings.get("permissions.audit.enabled") !== true) return;
		const record: AuditRecord = {
			ts: Date.now(),
			sessionId: context.sessionManager.getSessionId(),
			tool: this.tool.name,
			args,
			decision: decision.policy,
			outcome,
		};
		const command = auditCommand(args);
		if (command !== undefined) record.command = command;
		if (decision.ruleId !== undefined) record.ruleId = decision.ruleId;
		if (decision.layer !== undefined) record.layer = decision.layer;
		if (decision.reason !== undefined) record.reason = decision.reason;
		if (decision.pieces !== undefined) record.pieces = decision.pieces;
		try {
			await appendAudit(
				auditFilePath(engineCtx.cwd),
				record,
				engineCtx.settings.get("permissions.audit.maxEntries"),
			);
		} catch (err) {
			if (!auditWarned) {
				auditWarned = true;
				logger.warn("Permission audit append failed", { error: err instanceof Error ? err.message : String(err) });
			}
		}
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
		const shortCircuitArgs = approvalArgs(params, context);
		const shortCircuit = evaluatePermission(this.tool, shortCircuitArgs, engineCtx);
		if (shortCircuit.policy === "deny") {
			await this.#recordAudit(shortCircuit, shortCircuitArgs, "blocked", context, engineCtx);
			throw blockedByPolicyError(this.tool.name, shortCircuit, shortCircuitArgs, engineCtx);
		}

		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with. Doing this BEFORE the approval gate means approval (below) resolves against the
		// input that actually executes, closing the "approve one thing, run another" gap: the prompt
		// text, policy resolution, and provider safety checks all see `effectiveParams`.
		let effectiveParams = params;
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall(
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						input: normalizeToolEventInput(
							this.tool.name,
							resolveToolEventInput(this.tool, toolEventArgs(params, context)),
						),
					},
					signal,
				)) as ToolCallEventResult | undefined;

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
		// short-circuit above. When no handler revised the input the short-circuit decision is
		// authoritative for the same args — re-evaluating would repeat every rule-layer load and bash
		// piece analysis for an identical result, so reuse it.
		const resolvedArgs = approvalArgs(effectiveParams, context);
		const decision =
			effectiveParams === params ? shortCircuit : evaluatePermission(this.tool, resolvedArgs, engineCtx);
		context?.xdevTierResolved?.(decision.tier);
		if (decision.policy === "deny") {
			await this.#recordAudit(decision, resolvedArgs, "blocked", context, engineCtx);
			throw blockedByPolicyError(this.tool.name, decision, resolvedArgs, engineCtx);
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
		const acpBypass =
			context !== undefined &&
			Object.hasOwn(context, "acpApprovedArgs") &&
			Bun.deepEquals(effectiveParams, context.acpApprovedArgs);
		const approvalCheck = {
			required:
				pendingSafetyChecks.length > 0 ||
				(decision.policy === "prompt" &&
					!acpBypass &&
					(decision.source === "tool" || decision.source === "user" || decision.override || !xdevBypass)),
			reason: decision.reason,
		};

		if (approvalCheck.required) {
			const scheduledCall = context?.toolCall?.toolCalls[context.toolCall.index];
			if (
				scheduledCall?.id === toolCallId &&
				(scheduledCall.name === this.tool.name || scheduledCall.name === this.tool.customWireName)
			) {
				await untilAborted(signal, () => this.runner.waitForToolApprovalPreview(toolCallId));
			}

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
			if (this.runner.hasUI()) {
				const uiContext = this.runner.getUIContext();
				const basePrompt = formatApprovalPrompt(this.tool, resolvedArgs, approvalCheck.reason);
				const safetyPrompt =
					pendingSafetyChecks.length > 0
						? `${basePrompt}\nProvider safety checks:\n${safetyCheckLines(pendingSafetyChecks).join("\n")}`
						: basePrompt;
				const includeCandidates = pendingSafetyChecks.length === 0;
				// Task 11 (§5.3): LLM rule suggestions ride on the session's active
				// model. Without a registry/model handle the gate degrades to
				// candidates-only (the provider also self-gates on
				// `permissions.llmSuggestions`). Provider safety-check prompts never
				// get suggestions — they are stronger than any rule.
				const suggestionsProvider =
					includeCandidates && context?.modelRegistry !== undefined
						? createSuggestionProvider(engineCtx, context.modelRegistry, sessionId || undefined, context.model)
						: undefined;
				let resolution: PromptResolution;
				try {
					resolution = await promptForDecision(uiContext, this.tool.name, resolvedArgs, decision, engineCtx, {
						// The v3 dialog titles itself ("Approve this command?") and
						// carries the approval reason and tool details in its
						// metadata lines; the legacy full-prompt title stays only
						// for provider-safety forced prompts, whose binary flow
						// keeps the whole text.
						...(includeCandidates
							? {
									approvalReason: approvalCheck.reason,
									approvalDetails: this.tool.formatApprovalDetails?.(resolvedArgs),
								}
							: { title: safetyPrompt }),
						// Provider safety checks are stronger than any rule: the dialog
						// shows without candidates and only offers Approve/Deny.
						includeCandidates,
						...(suggestionsProvider !== undefined ? { suggestionsProvider } : {}),
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
					await this.#recordAudit(
						{ ...decision, policy: "deny" as const, reason: "denied by user" },
						resolvedArgs,
						"blocked",
						context,
						engineCtx,
					);
					throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
				if (pendingSafetyChecks.length > 0) {
					if (!context) throw new Error("Provider safety approval context is unavailable");
					context.providerSafetyApproved = true;
				}
			} else {
				if (pendingSafetyChecks.length > 0) {
					await this.#recordAudit(decision, resolvedArgs, "blocked", context, engineCtx);
					await emitApprovalResolved(false, "no interactive UI available");
					throw new Error(
						`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,
					);
				}
				// Ordinary pending decisions park (spec §6): the call blocks on a
				// promise until the root session's permission handler answers or
				// the agent is aborted. Without a handler anywhere up the session
				// tree parkApproval throws the legacy no-UI error — fail-closed,
				// preserving print/RPC/ACP behavior. The branch is terminal:
				// allow continues to execution, deny throws the standard error —
				// the no-op UI context must never see the call again.
				const pending: PendingApproval = {
					key: `${this.tool.name}:${toolCallId}`,
					sessionId,
					toolName: this.tool.name,
					args: resolvedArgs,
					decision,
					// The parked promise is owned by parkApproval, which installs
					// the real resolvers; these stubs only satisfy the interface.
					resolve: () => {},
					reject: () => {},
				};
				let resolution: { policy: "allow" | "deny" };
				try {
					resolution = await raceParkedApproval(parkApproval(pending), signal, sessionId, this.tool.name);
				} catch (err) {
					await this.#recordAudit(decision, resolvedArgs, "blocked", context, engineCtx);
					const message = err instanceof Error ? err.message : "approval aborted";
					await emitApprovalResolved(
						false,
						message.includes("no interactive UI available") ? "no interactive UI available" : message,
					);
					throw err;
				}
				await emitApprovalResolved(
					resolution.policy === "allow",
					resolution.policy === "deny" ? "denied by user" : undefined,
				);
				if (resolution.policy === "deny") {
					await this.#recordAudit(
						{ ...decision, policy: "deny" as const, reason: "denied by user" },
						resolvedArgs,
						"blocked",
						context,
						engineCtx,
					);
					throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
			}
		}

		// Execute the actual tool
		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			// Name the owning session for process-wide file-mutation fallbacks and
			// expose its settings to registered tools and any fallback handlers they
			// trigger. `sdk.ts` wraps the whole tool registry with this class whenever
			// a runner exists.
			result = await this.runner.runScoped(() =>
				withFileMutationSession(this.runner.sessionId, () =>
					this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context),
				),
			);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Record the final decision after the actual execution outcome is known.
		await this.#recordAudit(decision, resolvedArgs, executionError ? "error" : "executed", context, engineCtx);

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
				isError: !!executionError || result.isError === true,
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
