/**
 * Focused-view permission answering (spec §6): the interactive-mode side of
 * the park-and-bubble flow.
 *
 * The root session installs one handler here. On a parked subagent approval
 * the handler (a) notifies the root UI, (b) appends a `permission-pending`
 * custom entry to the parked subagent's session, and (c) returns a promise
 * the focused view settles. When the TUI re-points at the parked session
 * (`onFocusAttached`, wired from the focus controller paths) the first
 * parked approval is presented through the existing
 * `ExtensionUiController.showPermissionDialog` dialog queue, preloaded with
 * that entry's candidates via `promptForDecision`; the chosen policy
 * resolves the handler promise (and remembers a dynamic rule when the user
 * picks a remember option). Cancelling the dialog denies.
 *
 * Also owns the spec §9.1 first-run migration notices: interactive mode calls
 * `showFirstRunNotices` once per session start.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { AgentRef } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { EngineContext } from "../../tools/permissions/engine";
import { firstRunNotice } from "../../tools/permissions/migrate";
import { type PromptForDecisionOptions, promptForDecision } from "../../tools/permissions/prompt";
import {
	PERMISSION_PENDING_TYPE,
	type PendingApproval,
	pendingApprovalsForSession,
	registerPermissionHandler,
	unregisterPermissionHandler,
} from "../../tools/permissions/subagent";
import type { Suggestion } from "../../tools/permissions/suggest";

export interface PermissionControllerDeps {
	/** Root session-manager id — the namespace the answering handler is registered in. */
	rootSessionId: string;
	/** Root UI surface (notify + approval dialog); undefined before hook init. */
	ui: () => ExtensionUIContext | undefined;
	/**
	 * Resolve a live registry ref by its attached session-manager id (the
	 * bridge the pending carries). Supplies both the parked session (for the
	 * entry append) and the display identity for the root notice — the wrapper
	 * never sets `PendingApproval.agentId`, so the ref's display name is the
	 * only user-facing subagent identity available.
	 */
	agentRefByManagerId: (sessionId: string) => AgentRef | undefined;
	/** Engine context (cwd/home) used for remembered-rule writes, scoped to the parked session. */
	engineContext: (session: AgentSession | undefined) => EngineContext;
	/**
	 * Optional async LLM rule-suggestion provider for the focused dialog (spec
	 * §6.1, Task 11 wiring pattern). Undefined/absent → candidates-only, the
	 * same degradation the main dialog uses.
	 */
	suggestionsProvider?:
		| ((
				session: AgentSession | undefined,
				engineCtx: EngineContext,
		  ) => ((piece: string) => Promise<Suggestion[]>) | undefined)
		| undefined;
	/** Session-manager id of the session the TUI is attached to, or undefined when detached. */
	attachedManagerId: () => string | undefined;
}

/** Cap for the command shown in transient root notifications. */
const NOTIFY_COMMAND_MAX = 100;

function pendingCommandSummary(pending: PendingApproval): string {
	let command: unknown;
	if (
		pending.toolName === "bash" &&
		pending.args !== null &&
		typeof pending.args === "object" &&
		!Array.isArray(pending.args)
	) {
		command = (pending.args as Record<string, unknown>).command;
	}
	const text =
		typeof command === "string" && command.length > 0
			? command
			: `${pending.toolName} ${JSON.stringify(pending.args)}`;
	return truncateToWidth(text.replace(/[\r\n]+/g, " "), NOTIFY_COMMAND_MAX);
}

export class PermissionController {
	#deps: PermissionControllerDeps;
	/** Answerers for parked approvals, keyed by pending.key; settled by the focused-view dialog. */
	#answerers = new Map<string, (resolution: { policy: "allow" | "deny" }) => void>();
	/** Keys whose dialog is presented or queued — focus churn must not stack duplicates. */
	#dialogKeys = new Set<string>();

	constructor(deps: PermissionControllerDeps) {
		this.#deps = deps;
	}

	/** Install the root answering handler. Called once per session start. */
	install(): void {
		registerPermissionHandler(this.#deps.rootSessionId, pending => this.#handleParked(pending));
	}

	/** Unregister the handler and settle every unanswered park as denied — no call may hang on shutdown. */
	dispose(): void {
		unregisterPermissionHandler(this.#deps.rootSessionId);
		for (const answer of this.#answerers.values()) answer({ policy: "deny" });
		this.#answerers.clear();
		this.#dialogKeys.clear();
	}

	/** The TUI re-pointed at `session` — surface any parked approval for it now. */
	onFocusAttached(session: AgentSession): void {
		this.#presentPendingFor(session.sessionManager.getSessionId());
	}

	#handleParked(pending: PendingApproval): Promise<{ policy: "allow" | "deny" }> {
		const command = pendingCommandSummary(pending);
		const ref = this.#deps.agentRefByManagerId(pending.sessionId);
		const session = ref?.session ?? undefined;
		// The wrapper never sets `agentId`, so the registry ref's display name
		// is the user-facing identity for the notice and the entry.
		const agentLabel = ref?.displayName || ref?.id || pending.sessionId;
		// Warning type: the default info notice was easy to miss (user finding 2026-08-13).
		this.#deps.ui()?.notify(`Subagent ${agentLabel} is waiting for approval: ${command}`, "warning");
		session?.sessionManager.appendCustomMessageEntry(PERMISSION_PENDING_TYPE, "", true, {
			agentId: agentLabel,
			toolName: pending.toolName,
			command,
			key: pending.key,
		});
		const { promise, resolve } = Promise.withResolvers<{ policy: "allow" | "deny" }>();
		this.#answerers.set(pending.key, resolve);
		this.#presentIfFocused(pending);
		return promise;
	}

	#presentIfFocused(pending: PendingApproval): void {
		if (this.#deps.attachedManagerId() === pending.sessionId) {
			void this.#presentFor(pending);
		}
	}

	#presentPendingFor(sessionId: string): void {
		for (const pending of pendingApprovalsForSession(sessionId)) {
			if (!this.#dialogKeys.has(pending.key)) {
				void this.#presentFor(pending);
				return;
			}
		}
	}

	async #presentFor(pending: PendingApproval): Promise<void> {
		// Aborted or already answered while the dialog was queued — nothing to ask about.
		if (!pendingApprovalsForSession(pending.sessionId).some(p => p.key === pending.key)) return;
		if (this.#dialogKeys.has(pending.key)) return;
		this.#dialogKeys.add(pending.key);
		const ref = this.#deps.agentRefByManagerId(pending.sessionId);
		const session = ref?.session ?? undefined;
		const agentLabel = ref?.displayName || ref?.id || pending.sessionId;
		const engineCtx = this.#deps.engineContext(session);
		let answered = false;
		try {
			const ui = this.#deps.ui();
			const answer = this.#answerers.get(pending.key);
			if (!ui || !answer) return;
			const options: PromptForDecisionOptions = {
				title: `Subagent ${agentLabel} requests approval: ${pendingCommandSummary(pending)}`,
			};
			// Spec §6.1: async LLM rule suggestions ride on the parked session's
			// active model, mirroring the main dialog; unresolvable → candidates-only.
			const provider = this.#deps.suggestionsProvider?.(session, engineCtx);
			if (provider) options.suggestionsProvider = provider;
			const resolution = await promptForDecision(
				ui,
				pending.toolName,
				pending.args,
				pending.decision,
				engineCtx,
				options,
			);
			// The pending may have been aborted while its dialog sat in the
			// queue — drop the answerer instead of resolving a dead promise.
			if (!pendingApprovalsForSession(pending.sessionId).some(p => p.key === pending.key)) {
				this.#answerers.delete(pending.key);
				return;
			}
			this.#answerers.delete(pending.key);
			answered = true;
			answer({ policy: resolution.policy });
			// Acknowledge the answer: the pending entry's "waiting" heading alone
			// left the user unsure the answer landed (user finding 2026-08-13).
			this.#deps
				.ui()
				?.notify(
					`Approval answered: ${resolution.policy === "allow" ? "allowed" : "denied"} — ${agentLabel} resumed`,
				);
		} catch (err) {
			const answer = this.#answerers.get(pending.key);
			this.#answerers.delete(pending.key);
			if (answer) {
				answered = true;
				answer({ policy: "deny" });
			}
			logger.warn("Permission dialog failed; denying parked approval", { key: pending.key, error: String(err) });
		} finally {
			this.#dialogKeys.delete(pending.key);
			// Chain to the next parked approval of the same session.
			if (answered) this.#presentPendingFor(pending.sessionId);
		}
	}
}

/**
 * Surface the permission-migration mapping notices (spec §9.1) through the
 * root UI notify. Returns whether any notice was shown. Interactive mode
 * calls this once per session start (its init guard makes it once per
 * instance).
 */
export function showFirstRunNotices(
	settings: Settings,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): boolean {
	const notices = firstRunNotice(settings);
	if (!notices) return false;
	// The legacy keys are hidden from the settings UI yet still govern the
	// engine, so this must be unmissable: a warning-level summary naming the
	// remediation command, followed by the per-key mapping notices.
	const summary =
		"Permission migration pending: legacy permission settings (tools.approvalMode / tools.approval / bash.patterns) still govern the permission engine and are hidden from the settings UI. Run /permissions migrate to move them into permission rules and permissions.default.";
	logger.warn(summary);
	notify(summary, "warning");
	for (const notice of notices) notify(notice, "warning");
	return true;
}
