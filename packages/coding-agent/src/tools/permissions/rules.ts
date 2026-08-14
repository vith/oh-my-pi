import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, toError } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";

/**
 * Rule layers, ordered from highest to lowest precedence.
 *
 * - `dynamic`: rules written by the engine ("approve and remember").
 * - `project`: the repo's committed `.omp/permissions.yml`.
 * - `user`: hand-edited `~/.omp/agent/permissions.yml`.
 * - `curated`: bundled code defaults (not file-backed).
 * - `legacy`: migrated settings keys (not file-backed).
 */
export type RuleAction = "allow" | "deny" | "prompt";
export type RuleLayer = "dynamic" | "project" | "user" | "curated" | "legacy";

export interface PermissionRule {
	/** Unique within its file; auto-generated when absent. */
	id: string;
	/** Tool name, or `*` for any tool. */
	tool: string;
	/** Structured-arg patterns: equality, or glob/regex for string values. */
	match: Record<string, unknown>;
	action: RuleAction;
	reason?: string;
	/** Optional lifetime in seconds; expired rules are dropped at load and ignored at match time. */
	ttl?: number;
	/**
	 * Load-time expiry stamp (`Date.now() + ttl * 1000`), computed by {@link loadRuleLayers}.
	 * Rules without an explicit expiry expire relative to when their file was loaded.
	 */
	expiresAt?: number;
	layer: RuleLayer;
}

export interface RuleLoadResult {
	rules: PermissionRule[];
	errors: string[];
}

/** File-backed layers in load order (highest precedence first). */
const LAYER_ORDER = ["dynamic", "project", "user"] as const;

const RULE_ACTIONS: readonly RuleAction[] = ["allow", "deny", "prompt"];

/**
 * Resolve the three file-backed rule layer files.
 *
 * `project` walks up from `cwd` to the nearest directory containing
 * `.omp/permissions.yml` (same walking shape as omp's
 * `findAllNearestProjectConfigDirs`), falling back to `<cwd>/.omp/permissions.yml`
 * when no ancestor has one.
 */
export function ruleFiles(cwd: string, home?: string): { dynamic: string; project: string; user: string } {
	const homeDir = home ?? os.homedir();
	return {
		dynamic: path.join(homeDir, ".omp", "agent", "permissions.dynamic.yml"),
		project: path.join(findNearestProjectRoot(cwd), ".omp", "permissions.yml"),
		user: path.join(homeDir, ".omp", "agent", "permissions.yml"),
	};
}

/**
 * Walk up from `cwd`, returning the nearest directory that contains a
 * `.omp/permissions.yml` file, or `cwd` itself when none does.
 */
function findNearestProjectRoot(cwd: string): string {
	let currentDir = path.resolve(cwd);
	while (true) {
		try {
			if (fs.statSync(path.join(currentDir, ".omp", "permissions.yml")).isFile()) {
				return currentDir;
			}
		} catch {
			// no permissions file at this level — continue up
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break; // filesystem root
		currentDir = parentDir;
	}
	return path.resolve(cwd);
}

/**
 * Result cache for {@link loadRuleLayers}: the layer files are read and
 * parsed on every permission evaluation (per bash piece, per tool call), so
 * cache the parsed result per (cwd, home, resolved file set) and invalidate
 * when any layer file's mtime/size changes or a file appears/disappears. The
 * resolved paths are part of the key so a project-root layer appearing or
 * disappearing (which changes the resolved project file) misses instead of
 * serving stale rules. Tests mutate temp rule files rapidly; size is compared
 * alongside mtime so same-mtime rewrites are still detected.
 */
interface RuleLayerCacheEntry {
	stats: Array<{ mtimeMs: number; size: number } | null>;
	result: RuleLoadResult;
}

const ruleLayerCache = new Map<string, RuleLayerCacheEntry>();

/** Drop the cached rule-layer loads (tests that rewrite rule files rapidly). */
export function clearRuleLayerCache(): void {
	ruleLayerCache.clear();
}

function layerFileStats(files: {
	dynamic: string;
	project: string;
	user: string;
}): Array<{ mtimeMs: number; size: number } | null> {
	const stats: Array<{ mtimeMs: number; size: number } | null> = [];
	for (const file of [files.dynamic, files.project, files.user]) {
		try {
			const stat = fs.statSync(file);
			stats.push({ mtimeMs: stat.mtimeMs, size: stat.size });
		} catch {
			// Missing file (or unreadable at stat time): the load reports the
			// real read error; a null stat always counts as a change so the
			// entry cannot be served stale.
			stats.push(null);
		}
	}
	return stats;
}

function sameLayerFileStats(
	left: Array<{ mtimeMs: number; size: number } | null>,
	right: Array<{ mtimeMs: number; size: number } | null>,
): boolean {
	for (let i = 0; i < left.length; i++) {
		const a = left[i];
		const b = right[i];
		if (a === null || b === null) {
			if (a !== b) return false;
			continue;
		}
		if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false;
	}
	return true;
}

/**
 * Load the three file-backed layers in precedence order (dynamic → project → user),
 * deduplicating ids within each file, dropping expired rules, and collecting
 * per-file errors. A broken or missing file contributes no rules.
 */
export function loadRuleLayers(cwd: string, home?: string): RuleLoadResult {
	const files = ruleFiles(cwd, home);
	const key = `${cwd}\u0000${home ?? ""}\u0000${files.dynamic}\u0000${files.project}\u0000${files.user}`;
	const stats = layerFileStats(files);
	const cached = ruleLayerCache.get(key);
	if (cached !== undefined && sameLayerFileStats(cached.stats, stats)) {
		return cached.result;
	}

	const rules: PermissionRule[] = [];
	const errors: string[] = [];
	for (const layer of LAYER_ORDER) {
		const loaded = loadRuleFile(files[layer], layer);
		rules.push(...loaded.rules);
		errors.push(...loaded.errors);
	}
	const result: RuleLoadResult = { rules, errors };
	ruleLayerCache.set(key, { stats, result });
	return result;
}

function loadRuleFile(file: string, layer: RuleLayer): { rules: PermissionRule[]; errors: string[] } {
	const result: { rules: PermissionRule[]; errors: string[] } = { rules: [], errors: [] };

	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return result;
		result.errors.push(`RuleLoadError: ${file}: ${toError(error).message}`);
		return result;
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		result.errors.push(`RuleLoadError: ${file}: ${toError(error).message}`);
		return result;
	}

	if (parsed === null || parsed === undefined) return result; // empty file
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		result.errors.push(`RuleLoadError: ${file}: top-level value must be a mapping with a "rules" list`);
		return result;
	}

	const rulesValue = (parsed as Record<string, unknown>).rules;
	if (rulesValue === undefined) return result; // no rules key — nothing to load
	if (!Array.isArray(rulesValue)) {
		result.errors.push(`RuleLoadError: ${file}: "rules" must be a list`);
		return result;
	}

	const seenIds = new Set<string>();
	for (const [index, record] of rulesValue.entries()) {
		const rule = normalizeRuleAt(record, layer, index);
		if (rule === null) {
			result.errors.push(
				`RuleLoadError: ${file}: rule at index ${index} is invalid (tool, non-empty match, and action allow|deny|prompt are required)`,
			);
			continue;
		}
		if (seenIds.has(rule.id)) {
			result.errors.push(`RuleLoadError: ${file}: duplicate rule id "${rule.id}"`);
			continue;
		}
		seenIds.add(rule.id);
		if (rule.ttl !== undefined) {
			rule.expiresAt = Date.now() + rule.ttl * 1000;
			if (isRuleExpired(rule)) continue; // expired relative to load time — drop
		}
		result.rules.push(rule);
	}
	return result;
}

/**
 * Validate an untrusted rule record against the global rule shape and normalize
 * it into a {@link PermissionRule}. Returns `null` when the record is malformed.
 *
 * `match` values pass through unvalidated: glob/regex strings are evaluated at
 * match time, and an invalid regex simply never matches.
 */
export function normalizeRule(record: unknown, layer: RuleLayer): PermissionRule | null {
	return normalizeRuleAt(record, layer, 0);
}

function normalizeRuleAt(record: unknown, layer: RuleLayer, index: number): PermissionRule | null {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return null;

	const { id, tool, match, action, reason, ttl } = record as Record<string, unknown>;

	if (typeof tool !== "string" || tool.length === 0) return null;
	if (typeof match !== "object" || match === null || Array.isArray(match) || Object.keys(match).length === 0) {
		return null;
	}
	const matchRecord = match as Record<string, unknown>;
	if (!RULE_ACTIONS.includes(action as RuleAction)) return null;
	if (id !== undefined && (typeof id !== "string" || id.length === 0)) return null;
	if (reason !== undefined && typeof reason !== "string") return null;
	if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl))) return null;

	const rule: PermissionRule = {
		id: typeof id === "string" ? id : autoRuleId(tool, matchRecord, index),
		tool,
		match: matchRecord,
		action: action as RuleAction,
		layer,
	};
	if (typeof reason === "string") rule.reason = reason;
	if (typeof ttl === "number") rule.ttl = ttl;
	return rule;
}

/**
 * Deterministic per-file id: `slug(tool)-slug(match values)-index`. The index
 * (position in the file) keeps ids unique within a file.
 */
function autoRuleId(tool: string, match: Record<string, unknown>, index: number): string {
	const matchSlug = slugify(Object.values(match).join("-")).slice(0, 24);
	return `${slugify(tool)}-${matchSlug}-${index}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * A rule with a `ttl` expires when its load-time expiry stamp passes.
 * Rules without a `ttl` never expire.
 */
export function isRuleExpired(rule: PermissionRule, now: number = Date.now()): boolean {
	return rule.ttl !== undefined && (rule.expiresAt ?? 0) <= now;
}

/**
 * Append or replace (by `id`) a rule in the dynamic rules file. The write is
 * atomic and serialized with other writers through an OS-backed file lock
 * (Task 2 deferred minor; the management surface adds real callers). The
 * `layer` field is derived from the file's position at load time and is not
 * stored.
 */
export async function writeDynamicRule(
	file: string,
	rule: Omit<PermissionRule, "layer"> & { layer?: RuleLayer },
): Promise<void> {
	await upsertRuleInFile(file, rule);
}

/**
 * Append or replace (by `id`) a rule in the user rules file (the management
 * surface's write path). Same atomic + locked semantics as
 * {@link writeDynamicRule}.
 */
export async function writeUserRule(
	file: string,
	rule: Omit<PermissionRule, "layer"> & { layer?: RuleLayer },
): Promise<void> {
	await upsertRuleInFile(file, rule);
}

async function upsertRuleInFile(
	file: string,
	rule: Omit<PermissionRule, "layer"> & { layer?: RuleLayer },
): Promise<void> {
	const entry = ruleToEntry(rule);
	await mutateRuleDoc(file, rules => {
		// Always a new array: the RMW core treats the original reference as
		// "unchanged" and would otherwise skip the write for in-place edits.
		const next = [...rules];
		const existingIndex = next.findIndex(candidate => candidate.id === entry.id);
		if (existingIndex >= 0) {
			next[existingIndex] = entry;
		} else {
			next.push(entry);
		}
		return next;
	});
}

function ruleToEntry(rule: Omit<PermissionRule, "layer"> & { layer?: RuleLayer }): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		id: rule.id,
		tool: rule.tool,
		match: rule.match,
		action: rule.action,
	};
	if (rule.reason !== undefined) entry.reason = rule.reason;
	if (rule.ttl !== undefined) entry.ttl = rule.ttl;
	return entry;
}

/**
 * Remove a rule by `id` from the dynamic rules file.
 * Returns whether a rule with that id existed (and the file was rewritten).
 */
export async function removeDynamicRule(file: string, id: string): Promise<boolean> {
	return removeRuleFromFile(file, id);
}

/**
 * Remove a rule by `id` from the project rules file.
 * Returns whether a rule with that id existed.
 */
export async function removeProjectRule(file: string, id: string): Promise<boolean> {
	return removeRuleFromFile(file, id);
}

/**
 * Remove a rule by `id` from the user rules file (the management surface's
 * remove path). Returns whether a rule with that id existed.
 */
export async function removeUserRule(file: string, id: string): Promise<boolean> {
	return removeRuleFromFile(file, id);
}

async function removeRuleFromFile(file: string, id: string): Promise<boolean> {
	return await mutateRuleDoc(file, rules => {
		const remaining = rules.filter(candidate => candidate.id !== id);
		// Returning the original reference signals "unchanged": the core then
		// skips the write entirely, so a no-op remove neither rewrites nor
		// creates the file.
		return remaining.length === rules.length ? rules : remaining;
	});
}

/**
 * mkdir then run `fn` under the file lock — the single lock-acquisition site
 * for the rules files. The parent directory is created first because the lock
 * directory (`${file}.lock`) is made with a non-recursive mkdir.
 */
async function withRulesFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	return await withFileLock(file, fn);
}

/** Serialize a `{ rules }` document atomically. Must run inside {@link withRulesFileLock}. */
function writeRulesDoc(file: string, rules: Record<string, unknown>[]): Promise<void> {
	return writeYamlAtomically(file, { rules });
}

/**
 * Replace the whole `rules` list of a rules file under the file lock. This is
 * the public whole-list writer; the mutating writers ({@link writeDynamicRule}
 * et al.) share the same locked read-modify-write core, so every write to a
 * rules file is serialized (a bare read + rename could interleave).
 */
export async function writeRulesFile(file: string, rules: Record<string, unknown>[]): Promise<void> {
	await withRulesFileLock(file, () => writeRulesDoc(file, rules));
}

/**
 * Read-modify-write a rules file's `rules` list under the file lock, applying
 * `mutate` to the parsed list. Returns whether the file was rewritten: a
 * mutation that returns the original array reference (no change) neither
 * writes nor creates the file.
 */
async function mutateRuleDoc(
	file: string,
	mutate: (rules: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<boolean> {
	return await withRulesFileLock(file, async () => {
		const doc = await readDynamicDoc(file);
		const next = mutate(doc.rules);
		if (next === doc.rules) return false;
		await writeRulesDoc(file, next);
		return true;
	});
}

/** Read a dynamic rules file as a `{ rules }` document; missing or empty files yield no rules. */
async function readDynamicDoc(file: string): Promise<{ rules: Record<string, unknown>[] }> {
	let content: string;
	try {
		content = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return { rules: [] };
		throw error;
	}

	if (content.trim().length === 0) return { rules: [] };

	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(`Cannot write dynamic rules file ${file}: ${toError(error).message}`);
	}
	if (parsed === null || parsed === undefined) return { rules: [] };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Cannot write dynamic rules file ${file}: top-level value must be a mapping`);
	}

	const rulesValue = (parsed as Record<string, unknown>).rules;
	if (rulesValue === undefined) return { rules: [] };
	if (!Array.isArray(rulesValue)) {
		throw new Error(`Cannot write dynamic rules file ${file}: "rules" must be a list`);
	}
	return { rules: rulesValue as Record<string, unknown>[] };
}

/**
 * Write a YAML document atomically: serialize to a temp file in the same
 * directory, then rename over the target (atomic on the same filesystem).
 * Mirrors settings.ts's `#writeYamlAtomically` pattern (minus its EPERM dance,
 * which exists for that file's high-frequency write path).
 */
async function writeYamlAtomically(file: string, doc: unknown): Promise<void> {
	const tempPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await Bun.write(tempPath, YAML.stringify(doc, null, 2));
		await fs.promises.rename(tempPath, file);
	} catch (error) {
		await fs.promises.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}
