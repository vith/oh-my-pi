import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	buildDesktopNotifyCloseCommand,
	buildDesktopNotifyCommand,
	closeDesktopNotification,
	type DesktopNotifier,
	hasLinuxDesktopSession,
	isDesktopNotificationLive,
	resetDesktopNotificationTracking,
	resetDesktopNotifierCache,
	resolveDesktopNotifier,
	sendDesktopNotification,
	shouldDeliverDesktopNotification,
} from "@oh-my-pi/pi-tui/desktop-notify";
import * as utils from "@oh-my-pi/pi-utils";

const LINUX_ENV: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

describe("hasLinuxDesktopSession", () => {
	it("requires linux + a session bus address", () => {
		expect(hasLinuxDesktopSession("linux", LINUX_ENV)).toBe(true);
		expect(hasLinuxDesktopSession("linux", {})).toBe(false);
		expect(hasLinuxDesktopSession("darwin", LINUX_ENV)).toBe(false);
		expect(hasLinuxDesktopSession("win32", LINUX_ENV)).toBe(false);
	});

	it("accepts the systemd user bus socket when the address is not exported", () => {
		const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
		const fileExists = (path: string) => path === "/run/user/1000/bus";

		expect(hasLinuxDesktopSession("linux", env, fileExists)).toBe(true);
		expect(hasLinuxDesktopSession("linux", env, () => false)).toBe(false);
	});
});

describe("shouldDeliverDesktopNotification", () => {
	it("fires for VTE-family fallbacks (base/trueColor/alacritty) on a Linux session", () => {
		for (const id of ["base", "trueColor", "alacritty"] as const) {
			expect(shouldDeliverDesktopNotification(id, true, "linux", LINUX_ENV)).toBe(true);
		}
	});

	it("never fires when the terminal already speaks an in-band notify protocol", () => {
		// notifyProtocolIsBell=false means OSC 9 / OSC 99 already delivered the toast.
		expect(shouldDeliverDesktopNotification("kitty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("ghostty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("wezterm", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("iterm2", false, "linux", LINUX_ENV)).toBe(false);
	});

	it("lets Bell-only terminals use D-Bus while true in-band notify protocols skip it", () => {
		expect(shouldDeliverDesktopNotification("vscode", true, "linux", LINUX_ENV)).toBe(true);
		expect(shouldDeliverDesktopNotification("ghostty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("kitty", false, "linux", LINUX_ENV)).toBe(false);
	});

	it("respects the PI_NO_DESKTOP_NOTIFY=1 opt-out", () => {
		expect(
			shouldDeliverDesktopNotification("trueColor", true, "linux", {
				...LINUX_ENV,
				PI_NO_DESKTOP_NOTIFY: "1",
			}),
		).toBe(false);
	});

	it("requires a Linux desktop session — silent on macOS / Windows / headless Linux", () => {
		expect(shouldDeliverDesktopNotification("trueColor", true, "darwin", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("trueColor", true, "win32", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("trueColor", true, "linux", {})).toBe(false);
	});
});

describe("resolveDesktopNotifier", () => {
	beforeEach(() => {
		resetDesktopNotifierCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
	});

	it("prefers notify-send when libnotify is on PATH", () => {
		vi.spyOn(utils, "$which").mockImplementation(name =>
			name === "notify-send" ? "/usr/bin/notify-send" : "/usr/bin/gdbus",
		);
		expect(resolveDesktopNotifier()).toEqual({ kind: "notify-send", path: "/usr/bin/notify-send" });
	});

	it("falls back to gdbus when notify-send is missing", () => {
		vi.spyOn(utils, "$which").mockImplementation(name => (name === "gdbus" ? "/usr/bin/gdbus" : null));
		expect(resolveDesktopNotifier()).toEqual({ kind: "gdbus", path: "/usr/bin/gdbus" });
	});

	it("returns null when neither binary is installed", () => {
		vi.spyOn(utils, "$which").mockReturnValue(null);
		expect(resolveDesktopNotifier()).toBeNull();
	});

	it("caches the resolution so repeat calls do not re-probe PATH", () => {
		const spy = vi.spyOn(utils, "$which").mockReturnValue("/usr/bin/notify-send");
		resolveDesktopNotifier();
		resolveDesktopNotifier();
		resolveDesktopNotifier();
		// One call per probed binary on the first invocation, zero on cache hits.
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("buildDesktopNotifyCommand", () => {
	const notifySend: DesktopNotifier = { kind: "notify-send", path: "/usr/bin/notify-send" };
	const gdbus: DesktopNotifier = { kind: "gdbus", path: "/usr/bin/gdbus" };

	it("encodes string messages as title=app + body=message for notify-send", () => {
		expect(buildDesktopNotifyCommand(notifySend, "ping")).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"--print-id",
			"omp",
			"ping",
		]);
	});

	it("threads structured fields (title, body, urgency) through notify-send positional + flag args", () => {
		expect(
			buildDesktopNotifyCommand(notifySend, {
				title: "Session 12",
				body: "Complete",
				urgency: "critical",
			}),
		).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=critical",
			"--expire-time=5000",
			"--print-id",
			"Session 12",
			"Complete",
		]);
	});

	it("falls back to the app name when the structured title is blank", () => {
		expect(buildDesktopNotifyCommand(notifySend, { title: "   ", body: "Waiting for input" })).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"--print-id",
			"omp",
			"Waiting for input",
		]);
	});

	it("replaces the live notification when a tracked id exists", () => {
		expect(buildDesktopNotifyCommand(notifySend, "ping", 42)).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"--replace-id=42",
			"--print-id",
			"omp",
			"ping",
		]);
	});

	it("threads the tracked id through gdbus replaces_id", () => {
		expect(buildDesktopNotifyCommand(gdbus, { title: "Oh My Pi", body: "ping" }, 7)).toEqual([
			"/usr/bin/gdbus",
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.Notify",
			"omp",
			"7",
			"",
			"Oh My Pi",
			"ping",
			"[]",
			'{"urgency": <byte 1>}',
			"5000",
		]);
	});

	it("produces a freedesktop Notify call for gdbus including the urgency hint byte", () => {
		expect(buildDesktopNotifyCommand(gdbus, { title: "omp", body: "ping", urgency: "low" })).toEqual([
			"/usr/bin/gdbus",
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.Notify",
			"omp",
			"0",
			"",
			"omp",
			"ping",
			"[]",
			'{"urgency": <byte 0>}',
			"5000",
		]);
	});
});

describe("sendDesktopNotification", () => {
	beforeEach(() => {
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
	});

	it("fires Bun.spawn with the resolved notify-send argv and unref's the child so it never blocks process exit", () => {
		vi.spyOn(utils, "$which").mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		const unref = vi.fn();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		sendDesktopNotification({ title: "Session", body: "Complete" });

		expect(spawn).toHaveBeenCalledTimes(1);
		const opts = spawn.mock.calls[0]?.[0] as unknown as {
			cmd: string[];
			stdin: string;
			stdout: string;
			stderr: string;
		};
		expect(opts.cmd).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"omp",
			"--urgency=normal",
			"--expire-time=5000",
			"--print-id",
			"Session",
			"Complete",
		]);
		expect(opts.stdin).toBe("ignore");
		// stdout is piped so the daemon-assigned id can be captured for
		// replace/close; a child without a readable stdout simply yields no id.
		expect(opts.stdout).toBe("pipe");
		expect(opts.stderr).toBe("ignore");
		// `.unref()` is what actually decouples a slow notifier from process exit;
		// without it Bun keeps the event loop pinned to the child even with
		// stdio: "ignore".
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("is a silent no-op when no notifier binary is installed", () => {
		vi.spyOn(utils, "$which").mockReturnValue(null);
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		sendDesktopNotification("ping");

		expect(spawn).not.toHaveBeenCalled();
	});

	it("swallows spawn failures so a missing daemon never throws into the renderer", () => {
		vi.spyOn(utils, "$which").mockReturnValue("/usr/bin/notify-send");
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(() => sendDesktopNotification("ping")).not.toThrow();
	});

	it("tracks the notify-send id so the next toast replaces it", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		sendDesktopNotification("second");
		await Bun.sleep(0);

		const cmds = spawn.mock.calls.map(call => (call[0] as unknown as { cmd: string[] }).cmd);
		expect(cmds[0]).not.toContain("--replace-id=42");
		// The second toast replaces the first instead of stacking a new entry.
		expect(cmds[1]).toContain("--replace-id=42");
	});

	it("tracks the gdbus reply id from its GLib variant tuple", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "gdbus" ? "/usr/bin/gdbus" : null));
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((..._args: unknown[]) => childWithStdout("(uint32 7,)", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		sendDesktopNotification("second");

		const cmds = spawn.mock.calls.map(call => (call[0] as unknown as { cmd: string[] }).cmd);
		// replaces_id is the positional argument after the app name in
		// `Notify(s u s s s as a{sv} i)`.
		expect(cmds[1]![10]).toBe("7");
	});
});

/** Fake spawn child whose stdout yields `text` once and then EOF. */
function childWithStdout(text: string, unref: ReturnType<typeof vi.fn>): unknown {
	const encoder = new TextEncoder();
	let yielded = false;
	return {
		unref,
		stdout: {
			getReader: () => ({
				read: async () => {
					if (!yielded) {
						yielded = true;
						return { done: false as const, value: encoder.encode(text) };
					}
					return { done: true as const, value: undefined };
				},
			}),
		},
	};
}

describe("buildDesktopNotifyCloseCommand", () => {
	const gdbus: DesktopNotifier = { kind: "gdbus", path: "/usr/bin/gdbus" };
	const notifySend: DesktopNotifier = { kind: "notify-send", path: "/usr/bin/notify-send" };

	it("produces a CloseNotification call for gdbus", () => {
		expect(buildDesktopNotifyCloseCommand(gdbus, 42)).toEqual([
			"/usr/bin/gdbus",
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.CloseNotification",
			"42",
		]);
	});

	it("returns null for notify-send, which has no close option", () => {
		expect(buildDesktopNotifyCloseCommand(notifySend, 42)).toBeNull();
	});
});

describe("closeDesktopNotification", () => {
	beforeEach(() => {
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
	});

	it("closes the tracked notification via gdbus and clears the id", async () => {
		const which = vi.spyOn(utils, "$which");
		// The send prefers notify-send; the close must still reach gdbus.
		which.mockImplementation(name =>
			name === "notify-send" ? "/usr/bin/notify-send" : name === "gdbus" ? "/usr/bin/gdbus" : null,
		);
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		spawn.mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		closeDesktopNotification();

		expect(spawn).toHaveBeenLastCalledWith({
			cmd: [
				"/usr/bin/gdbus",
				"call",
				"--session",
				"--dest",
				"org.freedesktop.Notifications",
				"--object-path",
				"/org/freedesktop/Notifications",
				"--method",
				"org.freedesktop.Notifications.CloseNotification",
				"42",
			],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});

		// The tracked id is cleared, so a repeated close is a no-op: only the
		// send and the first close spawned.
		closeDesktopNotification();
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("is a silent no-op when no notification is tracked", () => {
		vi.spyOn(utils, "$which").mockReturnValue("/usr/bin/gdbus");
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		closeDesktopNotification();

		expect(spawn).not.toHaveBeenCalled();
	});

	it("swallows spawn failures so a missing daemon never throws into the renderer", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name =>
			name === "notify-send" ? "/usr/bin/notify-send" : name === "gdbus" ? "/usr/bin/gdbus" : null,
		);
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		spawn.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(() => closeDesktopNotification()).not.toThrow();
	});
});

describe("click-to-dismiss tracking", () => {
	const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	let writes: string[];

	beforeEach(() => {
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		writes = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
		resetDesktopNotificationTracking();
		if (stdoutIsTtyDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		} else {
			delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});

	it("arms button-event tracking when the daemon assigns a notification id", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		expect(writes).toContain("\x1b[?1000h\x1b[?1006h");
	});

	it("never arms when no id comes back, so selection stays untouched", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);

		expect(writes).toEqual([]);
	});

	it("disarms when the toast closes and stays disarmed for no-op closes", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name =>
			name === "notify-send" ? "/usr/bin/notify-send" : name === "gdbus" ? "/usr/bin/gdbus" : null,
		);
		const spawn = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);
		expect(writes).toContain("\x1b[?1000h\x1b[?1006h");

		spawn.mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);
		closeDesktopNotification();
		expect(writes.filter(w => w === "\x1b[?1006l\x1b[?1000l")).toHaveLength(1);

		// A repeated close is a no-op and must not toggle tracking again.
		closeDesktopNotification();
		expect(writes.filter(w => w === "\x1b[?1006l\x1b[?1000l")).toHaveLength(1);
	});

	it("isDesktopNotificationLive tracks the armed window", async () => {
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		expect(isDesktopNotificationLive()).toBe(false);
		sendDesktopNotification("first");
		await Bun.sleep(0);
		expect(isDesktopNotificationLive()).toBe(true);
		closeDesktopNotification();
		expect(isDesktopNotificationLive()).toBe(false);
	});

	it("writes no tracking sequences outside a real terminal", async () => {
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		const which = vi.spyOn(utils, "$which");
		which.mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => childWithStdout("42", vi.fn()) as never);

		sendDesktopNotification("first");
		await Bun.sleep(0);
		closeDesktopNotification();

		expect(writes).toEqual([]);
	});
});
