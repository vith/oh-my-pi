import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { YAML } from "bun";
import { engineSettingsFrom } from "../../../src/tools/permissions/settings";
import type { ExtensionUIContext, PermissionDialogRequest } from "../../../src/extensibility/extensions/types";
import {
	PermissionPendingComponent,
	type PermissionPendingDetails,
} from "../../../src/modes/components/permission-pending";
import {
	PermissionController,
	type PermissionControllerDeps,
	showFirstRunNotices,
} from "../../../src/modes/controllers/permission-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type AgentRef, AgentRegistry } from "../../../src/registry/agent-registry";
import type { AgentSession } from "../../../src/session/agent-session";
import type { CustomMessage } from "../../../src/session/messages";
import type { EngineDecision } from "../../../src/tools/permissions/engine";
import { firstRunNotice } from "../../../src/tools/permissions/migrate";
import { resolveLazy } from "../../../src/tools/permissions/prompt";
import {
	abortPendingForSession,
	PERMISSION_PENDING_TYPE,
	type PendingApproval,
	parkApproval,
	pendingApprovalsForSession,
	unregisterPermissionHandler,
} from "../../../src/tools/permissions/subagent";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

// Registry ids used by this file's fake session tree, mirroring the wrapper's
// real layout: refs are keyed by agent id and carry a live attached session
// whose session-manager id is the namespace pendings are parked in.
const ROOT_ID = "test-bubble-root";
const SUB_ID = "test-bubble-sub";
const ROOT_SESSION_ID = "sess-bubble-root";
const SUB_SESSION_ID = "sess-bubble-sub";
const FAKE_IDS = [ROOT_ID, SUB_ID];
const tempHomes = new Set<string>();

function fakeDecision(): EngineDecision {
	return { policy: "prompt", tier: "exec", source: "posture", override: false, reason: "no matching rule" };
}

// The wrapper never sets `PendingApproval.agentId` — identity comes from the
// registry ref's display name — so pendings here carry none either.
function makePending(sessionId: string, toolName = "bash"): PendingApproval {
	return {
		key: `${toolName}:${sessionId}:call-1`,
		sessionId,
		toolName,
		args: { command: "echo hi" },
		decision: fakeDecision(),
		resolve: () => {},
		reject: () => {},
	};
}

/** Minimal live-session double exposing just the session-manager id. */
function fakeSession(sessionId: string): AgentSession {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as AgentSession;
}

function registerTree(): void {
	AgentRegistry.global().register({
		id: ROOT_ID,
		displayName: ROOT_ID,
		kind: "main",
		session: fakeSession(ROOT_SESSION_ID),
		status: "idle",
	});
	AgentRegistry.global().register({
		id: SUB_ID,
		displayName: SUB_ID,
		kind: "sub",
		parentId: ROOT_ID,
		session: fakeSession(SUB_SESSION_ID),
		status: "running",
	});
}

afterEach(() => {
	for (const dir of tempHomes) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempHomes.clear();
	for (const id of FAKE_IDS) {
		unregisterPermissionHandler(id);
		abortPendingForSession(id);
		if (AgentRegistry.global().get(id)) AgentRegistry.global().unregister(id);
	}
	unregisterPermissionHandler(ROOT_SESSION_ID);
	unregisterPermissionHandler(SUB_SESSION_ID);
	abortPendingForSession(SUB_SESSION_ID);
	abortPendingForSession(ROOT_SESSION_ID);
});

describe("PermissionPendingComponent", () => {
	beforeAll(async () => {
		// render() styles through the global theme singleton (icons, box glyphs).
		await initTheme(false);
	});

	it("renders the waiting heading, the command, and the option summary from the entry details", () => {
		const message = {
			role: "custom",
			customType: PERMISSION_PENDING_TYPE,
			content: "",
			display: true,
			timestamp: 0,
			details: { agentId: "Worker", toolName: "bash", command: "git push origin main", key: "bash:call-1" },
		} as unknown as CustomMessage<PermissionPendingDetails>;

		const rendered = Bun.stripANSI(new PermissionPendingComponent(message).render(120).join("\n"));

		expect(rendered).toContain("⏳ Waiting for approval — focus this agent and press Enter to answer");
		expect(rendered).toContain("git push origin main");
		expect(rendered).toContain("Allow & remember");
		expect(rendered).toContain("Deny");
	});
});

interface BubbleHarness {
	controller: PermissionController;
	notify: ReturnType<typeof vi.fn>;
	showPermissionDialog: ReturnType<typeof vi.fn>;
	entries: Array<{ customType: string; data: unknown }>;
	capturedRequest: () => PermissionDialogRequest | undefined;
	setAttached: (sessionId: string | undefined) => void;
}

function makeController(
	options: { suggestionsProvider?: PermissionControllerDeps["suggestionsProvider"] } = {},
): BubbleHarness {
	// The engine resolves rules against the real home when `home` is undefined
	// (os.homedir()), which makes these tests depend on the developer's live
	// permission files — e.g. a remembered `echo *` allow rule silently turns
	// "echo hi" into an allowed call with no dialog. Isolate a temp home.
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bubble-test-"));
	tempHomes.add(tempHome);
	const notify = vi.fn();
	let capturedRequest: PermissionDialogRequest | undefined;
	// Mirror the real dialog component: lazy suggestion/preselect starters
	// fire on presentation (issue 13), not at prompt time.
	const mountDialog = (request: PermissionDialogRequest): void => {
		void resolveLazy(request.suggestions);
		void resolveLazy(request.preselect);
	};
	const showPermissionDialog = vi.fn(async (request: PermissionDialogRequest) => {
		capturedRequest = request;
		mountDialog(request);
		return 0; // index 0 = "Allow once"
	});
	const entries: Array<{ customType: string; data: unknown }> = [];
	const ui = { notify, showPermissionDialog } as unknown as ExtensionUIContext;
	const subSession = {
		sessionManager: {
			getSessionId: () => SUB_SESSION_ID,
			appendCustomMessageEntry: (_customType: string, _content: string, _display: boolean, details: unknown) => {
				entries.push({ customType: _customType, data: details });
				return "entry-1";
			},
		},
	} as unknown as AgentSession;
	// The registry ref carries the display identity the root notice resolves.
	const subRef = {
		id: SUB_ID,
		displayName: "Worker",
		kind: "sub",
		parentId: ROOT_ID,
		status: "running",
		session: subSession,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
	} as unknown as AgentRef;
	let attached: string | undefined;
	const controller = new PermissionController({
		rootSessionId: ROOT_SESSION_ID,
		ui: () => ui,
		agentRefByManagerId: id => (id === SUB_SESSION_ID ? subRef : undefined),
		engineContext: () => ({
			settings: engineSettingsFrom(Settings.isolated({})),
			cwd: process.cwd(),
			home: tempHome,
		}),
		...(options.suggestionsProvider !== undefined ? { suggestionsProvider: options.suggestionsProvider } : {}),
		attachedManagerId: () => attached,
	});
	return {
		controller,
		notify,
		showPermissionDialog,
		entries,
		capturedRequest: () => capturedRequest,
		setAttached: sessionId => {
			attached = sessionId;
		},
	};
}

describe("PermissionController", () => {
	it("notifies the root, appends a pending entry, and routes the focused-view answer to the parked promise", async () => {
		registerTree();
		const h = makeController();
		h.controller.install();
		const pending = makePending(SUB_SESSION_ID);
		const parked = parkApproval(pending);

		// Parked and visible, not yet answered.
		expect(pendingApprovalsForSession(SUB_SESSION_ID)).toEqual([pending]);

		// (a) root notification names the subagent (registry display name — the
		// wrapper never sets agentId) and the pending command; it is a warning so
		// it cannot be mistaken for a routine info notice.
		expect(h.notify).toHaveBeenCalledWith("Subagent Worker is waiting for approval: echo hi", "warning");

		// (b) a pending entry was appended to the SUBAGENT's session.
		expect(h.entries).toEqual([
			{
				customType: PERMISSION_PENDING_TYPE,
				data: { agentId: "Worker", toolName: "bash", command: "echo hi", key: pending.key },
			},
		]);

		// Not focused yet — no dialog.
		expect(h.showPermissionDialog).not.toHaveBeenCalled();

		// (c) focusing the subagent presents the approval dialog; the choice
		// resolves the parked promise.
		h.setAttached(SUB_SESSION_ID);
		h.controller.onFocusAttached(fakeSession(SUB_SESSION_ID));
		await expect(parked).resolves.toEqual({ policy: "allow" });
		expect(h.showPermissionDialog).toHaveBeenCalledTimes(1);

		// (d) the answer is acknowledged through the root UI with the policy.
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Approval answered: allowed"));

		// The answered pending is dropped from the registry.
		expect(pendingApprovalsForSession(SUB_SESSION_ID)).toEqual([]);

		h.controller.dispose();
	});

	it("presents the dialog immediately when the parked session is already focused", async () => {
		registerTree();
		const h = makeController();
		h.setAttached(SUB_SESSION_ID);
		h.controller.install();

		const parked = parkApproval(makePending(SUB_SESSION_ID));
		await expect(parked).resolves.toEqual({ policy: "allow" });
		expect(h.showPermissionDialog).toHaveBeenCalledTimes(1);
		expect(pendingApprovalsForSession(SUB_SESSION_ID)).toEqual([]);

		h.controller.dispose();
	});

	it("does not stack a second dialog for the same pending on focus churn", async () => {
		registerTree();
		const h = makeController();
		h.setAttached(SUB_SESSION_ID);
		h.controller.install();

		const parked = parkApproval(makePending(SUB_SESSION_ID));
		h.controller.onFocusAttached(fakeSession(SUB_SESSION_ID)); // churn while the dialog is queued
		await expect(parked).resolves.toEqual({ policy: "allow" });
		expect(h.showPermissionDialog).toHaveBeenCalledTimes(1);

		h.controller.dispose();
	});

	it("preloads the focused dialog with async LLM suggestions when a provider is supplied", async () => {
		registerTree();
		const provider = vi.fn(async () => ({ choices: [] }));
		const h = makeController({ suggestionsProvider: () => provider });
		h.controller.install();
		h.setAttached(SUB_SESSION_ID);

		const parked = parkApproval(makePending(SUB_SESSION_ID));
		await expect(parked).resolves.toEqual({ policy: "allow" });

		const request = h.capturedRequest();
		expect(request?.suggestions).toBeDefined();
		expect(provider).toHaveBeenCalledTimes(1);

		h.controller.dispose();
	});

	it("omits suggestions from the focused dialog when no provider is supplied", async () => {
		registerTree();
		const h = makeController();
		h.controller.install();
		h.setAttached(SUB_SESSION_ID);

		const parked = parkApproval(makePending(SUB_SESSION_ID));
		await expect(parked).resolves.toEqual({ policy: "allow" });
		expect(h.capturedRequest()?.suggestions).toBeUndefined();

		h.controller.dispose();
	});

	it("falls back to the session id in the notice when no registry ref resolves the parked session", async () => {
		registerTree();
		const h = makeController();
		h.controller.install();

		// Park under the root's own manager id: the root handler serves it, but
		// the fake ref lookup (which only knows the sub session) resolves
		// nothing, so the label falls back to the session id.
		const parked = parkApproval(makePending(ROOT_SESSION_ID));
		// Observe the parked promise so a late settle cannot surface as unhandled.
		const outcome = parked.then(
			() => null,
			() => null,
		);
		expect(h.notify).toHaveBeenCalledWith(`Subagent ${ROOT_SESSION_ID} is waiting for approval: echo hi`, "warning");

		h.controller.dispose();
		await outcome;
	});

	it("unregisters the root handler on dispose so new parks fail closed", async () => {
		registerTree();
		const h = makeController();
		h.controller.install();
		h.controller.dispose();

		await expect(parkApproval(makePending(SUB_SESSION_ID))).rejects.toThrow(
			/requires approval but no interactive UI available/,
		);
	});
});

describe("showFirstRunNotices", () => {
	let settingsState: SettingsTestState | undefined;
	let tmp: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bubble-notices-"));
		agentDir = path.join(tmp, "agent");
		cwd = path.join(tmp, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		// firstRunNotice resolves rule files against the OS home; point it at
		// the temp home so the real user's rules never leak into the plan.
		vi.spyOn(os, "homedir").mockReturnValue(path.join(tmp, "home"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
	});

	it("surfaces a warning summary plus each mapping notice via notify while legacy keys remain", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ tools: { approvalMode: "write" } }, null, 2),
		);
		const settings = await Settings.init({ agentDir, cwd });
		const notices = firstRunNotice(settings);
		expect(notices).not.toBeNull();
		const noticeList = notices ?? [];

		const notify = vi.fn();
		expect(showFirstRunNotices(settings, notify)).toBe(true);
		const calls = notify.mock.calls as Array<[string, string | undefined]>;
		// the summary names the remediation command and every message is a warning
		expect(calls[0][0]).toContain("/permissions migrate");
		expect(calls.every(call => call[1] === "warning")).toBe(true);
		// the mapping notices follow the summary in order
		expect(calls.slice(1).map(call => call[0])).toEqual(noticeList);
	});

	it("shows nothing on a clean config", async () => {
		const settings = await Settings.init({ agentDir, cwd });
		const notify = vi.fn();

		expect(showFirstRunNotices(settings, notify)).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});
});
