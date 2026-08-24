import { describe, expect, it } from "bun:test";
import { AgentRegistry, type RegistryEvent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

describe("AgentRegistry session attachment", () => {
	it("emits the exact live ref synchronously when a pre-registered session attaches", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "attach-Sub",
			displayName: "attach",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/pre-register.jsonl",
			status: "running",
		});
		const session = { isStreaming: true } as unknown as AgentSession;
		const events: RegistryEvent[] = [];
		let seenDuringEvent: typeof ref | undefined;
		registry.onChange(event => {
			events.push(event);
			seenDuringEvent = registry.get("attach-Sub");
		});

		expect(registry.attachSession("attach-Sub", session, "/tmp/attached.jsonl", ref)).toBe(true);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "session_attached", ref });
		expect(seenDuringEvent).toBe(ref);
		expect(seenDuringEvent).toMatchObject({
			status: "running",
			session,
			sessionFile: "/tmp/attached.jsonl",
		});
	});

	it("does not emit a session attachment event when the ownership CAS fails", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "attach-cas-Sub",
			displayName: "attach",
			kind: "sub",
			session: null,
			status: "running",
		});
		const events: RegistryEvent[] = [];
		registry.onChange(event => events.push(event));

		expect(registry.attachSession("attach-cas-Sub", {} as AgentSession, undefined, {} as AgentSession)).toBe(false);

		expect(registry.get("attach-cas-Sub")).toBe(ref);
		expect(ref.session).toBeNull();
		expect(events).toEqual([]);
	});
});
