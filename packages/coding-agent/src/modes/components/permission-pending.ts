import { Box, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "../../session/messages";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";

/** Entry data appended to the parked subagent's session (spec §6). */
export interface PermissionPendingDetails {
	agentId?: string;
	toolName: string;
	command: string;
	key: string;
}

/** Fixed heading of the pending card; the focused view answers on Enter. */
export const PERMISSION_PENDING_HEADING = "⏳ Waiting for approval — focus this agent and press Enter to answer";

/** Static option summary shown under the command (mirrors the dialog labels). */
export const PERMISSION_PENDING_OPTION_SUMMARY = "Options: Allow once · Allow & remember · Deny · Deny & remember";

/** Command display cap so the content-sized box cannot overflow the transcript. */
const COMMAND_MAX_WIDTH = 96;

/**
 * Transcript card for a parked subagent approval (spec §6). Rendered by the
 * `ui-helpers` custom branch for entries whose `customType` is
 * `PERMISSION_PENDING_TYPE`: a framed block with the waiting heading, the
 * pending command, and the option summary. The card is a static status block —
 * `setExpanded` is accepted for the shared custom-branch call shape but has
 * nothing to reveal.
 */
export class PermissionPendingComponent extends Box {
	constructor(message: CustomMessage<PermissionPendingDetails>) {
		super(1, 1, t => theme.bg("customMessageBg", t));
		this.setIgnoreTight(true);
		const command = (message.details?.command ?? "").replace(/[\r\n]+/g, " ").trim();
		this.setBorder({ chars: theme.boxRound, color: t => theme.fg("borderAccent", t) });
		this.addChild(new Text(theme.bold(theme.fg("accent", PERMISSION_PENDING_HEADING)), 0, 0));
		this.addChild(
			new Text(
				command.length > 0
					? theme.fg("customMessageText", truncateToWidth(replaceTabs(command), COMMAND_MAX_WIDTH))
					: theme.fg("muted", "(unknown command)"),
				0,
				0,
			),
		);
		this.addChild(new Text(theme.fg("muted", PERMISSION_PENDING_OPTION_SUMMARY), 0, 0));
	}

	setExpanded(_expanded: boolean): void {
		// Static status card — nothing to expand.
	}
}
