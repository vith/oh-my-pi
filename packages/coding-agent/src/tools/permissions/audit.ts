/**
 * Permission audit log: a rotating JSONL of final permission-engine decisions.
 *
 * One line per record, newest last on disk; `readAudit` returns newest-first.
 * The file lives at `<cwd>/.omp/permissions-audit.jsonl` so it sits next to
 * the session's other agent state. Rotation keeps the newest `maxEntries`
 * records once the file exceeds that many lines; the count is tracked per
 * file so an append costs a single write plus an O(1) map update (the
 * rotation read only happens past the threshold, so it is bounded by
 * maxEntries+1 lines).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { PermissionPolicy } from "./engine";
import type { RuleLayer } from "./rules";

export interface AuditRecord {
	ts: number;
	sessionId?: string;
	agent?: string;
	tool: string;
	command?: string;
	args?: unknown;
	decision: PermissionPolicy;
	ruleId?: string;
	layer?: RuleLayer;
	reason?: string;
	pieces?: Array<{ text: string; policy: PermissionPolicy }>;
	outcome?: "executed" | "blocked" | "error";
}

/** Same default as the `permissions.audit.maxEntries` settings schema entry. */
const DEFAULT_MAX_ENTRIES = 10_000;

/** In-process line counts per audit file, so rotation checks stay O(1). */
const lineCounts = new Map<string, number>();

export function auditFilePath(cwd: string): string {
	return path.join(cwd, ".omp", "permissions-audit.jsonl");
}

/**
 * Append one record as a JSONL line, rotating to the newest `maxEntries`
 * records once the file exceeds that many lines. Creates parent directories.
 * Never throws for caller-facing reasons (callers keep failures silent).
 */
export async function appendAudit(
	file: string,
	record: AuditRecord,
	maxEntries: number = DEFAULT_MAX_ENTRIES,
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
	const count = (lineCounts.get(file) ?? 0) + 1;
	lineCounts.set(file, count);
	if (maxEntries > 0 && count > maxEntries) {
		await rotate(file, maxEntries);
	}
}

/** Keep the newest `maxEntries` lines; bounded by maxEntries+1 lines on disk. */
async function rotate(file: string, maxEntries: number): Promise<void> {
	const text = await Bun.file(file).text();
	const lines = text.split("\n").filter(line => line.length > 0);
	const tail = lines.slice(-maxEntries);
	await Bun.write(file, tail.length > 0 ? `${tail.join("\n")}\n` : "");
	lineCounts.set(file, tail.length);
}

/**
 * Read the audit file newest-first. A missing file yields `[]`; malformed or
 * partial lines (e.g. a torn tail from a concurrent append) are skipped.
 */
export async function readAudit(file: string, limit?: number): Promise<AuditRecord[]> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const records: AuditRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			records.push(JSON.parse(line) as AuditRecord);
		} catch {
			// Skip lines that are not valid JSON — never break the log read.
		}
	}
	records.reverse();
	return limit !== undefined ? records.slice(0, limit) : records;
}
