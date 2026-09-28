// Linux desktop notification delivery via D-Bus.
//
// Several terminal families — most notably the VTE-based stack (Ptyxis,
// GNOME Terminal, Tilix, Terminator) but also Alacritty and bare xterm — have
// `notifyProtocol === Bell`, which means `formatNotification()` emits only a
// raw BEL. BEL alone never surfaces an arbitrary-text toast on those hosts
// (see #3685): Ptyxis hooks BEL to a CSS visual-bell flash, GNOME Terminal
// rings the audible bell. None of OSC 9 (ConEmu progress in VTE), OSC 99
// (unimplemented), or OSC 777 (only `notify;Command completed` → unused
// shell-postexec termprop in current VTE) produce a desktop notification.
//
// The freedesktop `org.freedesktop.Notifications` D-Bus service is the only
// path that consistently delivers toasts on those terminals across Wayland
// and X11. We invoke it out-of-process via `notify-send` (the canonical
// libnotify CLI present on every modern Linux desktop) and fall back to
// `gdbus call` when libnotify is absent but GLib is installed.
//
// Delivery is fire-and-forget: a failed spawn or missing binary is treated as
// a silent no-op so terminals that already deliver toasts in-band (Kitty,
// iTerm2, WezTerm, …) keep working unchanged and the BEL emission still fires
// for tmux `monitor-bell`, X11 urgency hints, and audible-bell handlers.

import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { TerminalId, TerminalNotification } from "./terminal-capabilities";

/** Application name surfaced as the notification source. */
const APP_NAME = "omp";

/** Resolved notifier binary used to fan a notification out to D-Bus. */
export type DesktopNotifierKind = "notify-send" | "gdbus";

export interface DesktopNotifier {
	kind: DesktopNotifierKind;
	path: string;
}

/**
 * Whether the current process can reach a freedesktop notification daemon:
 * Linux platform plus either a session bus address in env or the
 * systemd user-bus socket at `$XDG_RUNTIME_DIR/bus`. Caller is still responsible for
 * resolving a delivery binary via {@link resolveDesktopNotifier}.
 */
export function hasLinuxDesktopSession(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
	fileExists: (path: string) => boolean = fs.existsSync,
): boolean {
	if (platform !== "linux") return false;
	if (env.DBUS_SESSION_BUS_ADDRESS) return true;
	const runtimeDir = env.XDG_RUNTIME_DIR;
	return Boolean(runtimeDir && fileExists(path.join(runtimeDir, "bus")));
}

/**
 * Whether `sendNotification` should also dispatch a D-Bus toast for this
 * terminal. Returns true only when (1) the chosen `notifyProtocol` is BEL,
 * which cannot carry arbitrary toast text, (2) the host exposes a Linux desktop
 * session, and (3) the user has not opted out via `PI_NO_DESKTOP_NOTIFY=1`.
 * Terminals that genuinely speak OSC 9 / OSC 99 pass
 * `notifyProtocolIsBell=false` and are filtered before the D-Bus fallback can
 * run. Pure helper for tests and the singleton path.
 */
export function shouldDeliverDesktopNotification(
	_terminalId: TerminalId,
	notifyProtocolIsBell: boolean,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (!notifyProtocolIsBell) return false;
	if (!hasLinuxDesktopSession(platform, env)) return false;
	if (env.PI_NO_DESKTOP_NOTIFY === "1") return false;
	return true;
}

let cachedNotifier: DesktopNotifier | null | undefined;

/** Reset the cached notifier resolution. Tests only. */
export function resetDesktopNotifierCache(): void {
	cachedNotifier = undefined;
}

/**
 * Locate a libnotify-compatible delivery binary on `PATH`, preferring
 * `notify-send` (one-shot, no marshalling) and falling back to `gdbus call`
 * for hosts where libnotify is not installed but GLib is. Result is cached so
 * repeated notifications do not hit `$which` again.
 */
export function resolveDesktopNotifier(): DesktopNotifier | null {
	if (cachedNotifier !== undefined) return cachedNotifier;
	const notifySend = $which("notify-send");
	if (notifySend) {
		cachedNotifier = { kind: "notify-send", path: notifySend };
		return cachedNotifier;
	}
	const gdbus = $which("gdbus");
	if (gdbus) {
		cachedNotifier = { kind: "gdbus", path: gdbus };
		return cachedNotifier;
	}
	cachedNotifier = null;
	return null;
}

interface ResolvedNotificationFields {
	title: string;
	body: string;
	urgency: "low" | "normal" | "critical";
}

function resolveFields(message: string | TerminalNotification): ResolvedNotificationFields {
	if (typeof message === "string") {
		return { title: APP_NAME, body: message, urgency: "normal" };
	}
	const title = message.title?.trim() || APP_NAME;
	const body = message.body ?? "";
	const urgency = message.urgency === "critical" || message.urgency === "low" ? message.urgency : "normal";
	return { title, body, urgency };
}

const URGENCY_BYTE: Record<ResolvedNotificationFields["urgency"], number> = {
	low: 0,
	normal: 1,
	critical: 2,
};

/** TUI owns mouse tracking, including when a live toast needs click dismissal. */
const notificationListeners = new Set<() => void>();

export function onDesktopNotificationChange(listener: () => void): () => void {
	notificationListeners.add(listener);
	return () => notificationListeners.delete(listener);
}

function notifyListeners(): void {
	for (const listener of notificationListeners) listener();
}

/**
 * Build the argv that delivers `message` through the resolved notifier. Pure
 * helper so tests assert exact wire shape without spawning a child. Notes:
 * - `notify-send` accepts title + body positionally and a numeric expire
 *   timeout (`-t`); urgency is a flag. We always pass `--print-id` so the
 *   daemon-assigned id can be captured and used to replace or close the
 *   notification later, and `--replace-id` when a live notification exists
 *   so consecutive toasts collapse into one entry instead of stacking.
 * - `gdbus call ... Notify` takes the freedesktop signature
 *   `s u s s s as a{sv} i`: app_name, replaces_id, app_icon, summary, body,
 *   actions, hints, expire_timeout. We feed hints with the urgency byte so
 *   the daemon classifies the toast identically to `notify-send`.
 */
export function buildDesktopNotifyCommand(
	notifier: DesktopNotifier,
	message: string | TerminalNotification,
	replacesId?: number | null,
): string[] {
	const { title, body, urgency } = resolveFields(message);
	if (notifier.kind === "notify-send") {
		const args = [notifier.path, "--app-name", APP_NAME, `--urgency=${urgency}`, "--expire-time=5000"];
		if (replacesId != null) args.push(`--replace-id=${replacesId}`);
		args.push("--print-id", title, body);
		return args;
	}
	const hints = `{"urgency": <byte ${URGENCY_BYTE[urgency]}>}`;
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_NAME,
		String(replacesId ?? 0),
		"",
		title,
		body,
		"[]",
		hints,
		"5000",
	];
}

/**
 * Build the argv that closes the live notification via
 * `org.freedesktop.Notifications.CloseNotification`. Only `gdbus` can express
 * a close — `notify-send` has no close option — so a notify-send-only host
 * returns null and closing is a silent no-op (replacement still prevents
 * stacking). Pure helper so tests assert the wire shape without a child.
 */
export function buildDesktopNotifyCloseCommand(notifier: DesktopNotifier, id: number): string[] | null {
	if (notifier.kind !== "gdbus") return null;
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.CloseNotification",
		String(id),
	];
}

/**
 * Live notification id as assigned by the freedesktop daemon. Every send
 * replaces the previous notification (see `--replace-id` / `replaces_id`
 * above) and {@link closeDesktopNotification} closes it, so at most one omp
 * toast is ever live — the shell never accumulates unread entries.
 */
let currentDesktopNotificationId: number | null = null;

/**
 * Whether a daemon-assigned toast is currently live. The TUI gates main-view
 * mouse consumption on this: the first click clears a live toast without
 * activating underlying controls.
 */
export function isDesktopNotificationLive(): boolean {
	return currentDesktopNotificationId !== null;
}

/** Reset live-notification tracking. Tests only. */
export function resetDesktopNotificationTracking(): void {
	currentDesktopNotificationId = null;
}

/**
 * Parse the notification id out of a notifier's reply. `notify-send
 * --print-id` emits the bare decimal id; `gdbus call ... Notify` emits a
 * GLib variant tuple like `(uint32 42,)`.
 */
function parseDesktopNotificationId(output: string): number | null {
	const match = /\(uint32 (\d+),?\)/u.exec(output) ?? /^(\d+)/u.exec(output.trim());
	if (!match) return null;
	const id = Number(match[1]);
	return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Capture the daemon-assigned id from the notifier's stdout so the next
 * notification can replace it and staleness can close it. Bounded: a hung
 * notifier is killed after {@link NOTIFICATION_ID_READ_TIMEOUT_MS} so an
 * unresponsive D-Bus activation can never pin the process (the caller keeps
 * the child unref'd; the read must not keep the loop alive either).
 */
const NOTIFICATION_ID_READ_TIMEOUT_MS = 2000;

async function readDesktopNotificationId(child: { stdout?: unknown; kill?: () => void }): Promise<number | null> {
	const stdout = child.stdout as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | undefined;
	if (!stdout?.getReader) return null;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		try {
			child.kill?.();
		} catch {
			// Already gone; the pending read resolves on its own.
		}
	}, NOTIFICATION_ID_READ_TIMEOUT_MS);
	try {
		const reader = stdout.getReader();
		const chunks: string[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(new TextDecoder().decode(value));
		}
		clearTimeout(timeout);
		return timedOut ? null : parseDesktopNotificationId(chunks.join(""));
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget D-Bus desktop notification. Resolves a notifier, spawns it
 * detached, and never throws — terminal notifications are best-effort and
 * must not block the renderer or interleave bytes onto stdout. Caller is
 * responsible for the gating check
 * ({@link shouldDeliverDesktopNotification}).
 */
export function sendDesktopNotification(message: string | TerminalNotification): void {
	const notifier = resolveDesktopNotifier();
	if (!notifier) return;
	try {
		// `.unref()` lets the event loop exit while the notifier is still running.
		// Without it, an unresponsive D-Bus activation (slow `notify-send`, hung
		// `gdbus` waiting on a stalled session bus) would keep `omp` alive past
		// the renderer's shutdown — a completion toast must never delay process
		// exit. Ignored stdio alone does not detach the child from the parent's
		// reference count.
		const child = Bun.spawn({
			cmd: buildDesktopNotifyCommand(notifier, message, currentDesktopNotificationId),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		child.unref();
		// Track the daemon-assigned id so the next toast replaces this one and
		// closeDesktopNotification can clear it. The read is raced against a
		// kill timer and never throws; failure just means no replacement
		// tracking (a fresh notification, exactly the pre-fix behavior).
		void readDesktopNotificationId(child).then(id => {
			if (id === null) return;
			currentDesktopNotificationId = id;
			notifyListeners();
		});
	} catch {
		// Best-effort: a failed spawn is silent.
	}
}

/**
 * Close the live desktop notification, if any. Clears the tracked id so
 * repeated closes are no-ops. Best-effort: a missing notifier or a failed
 * spawn is silent. Caller is responsible for the gating check
 * ({@link shouldDeliverDesktopNotification}).
 */
export function closeDesktopNotification(): void {
	const id = currentDesktopNotificationId;
	if (id === null) return;
	currentDesktopNotificationId = null;
	notifyListeners();
	// Only gdbus can express a close — notify-send has no close option — so
	// resolve it directly instead of reusing the send path's cached notifier,
	// which prefers notify-send and would silently no-op every close on
	// machines where libnotify is installed.
	const gdbus = $which("gdbus");
	if (!gdbus) return;
	const cmd = buildDesktopNotifyCloseCommand({ kind: "gdbus", path: gdbus }, id);
	if (!cmd) return;
	try {
		const child = Bun.spawn({
			cmd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
	} catch {
		// Best-effort: a failed close is silent.
	}
}
