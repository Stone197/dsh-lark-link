// Workspace session listing for the Feishu-side /resume command, plus the
// saved-workspace store behind /ws (list|add|use|remove|status).
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Three layered sources (same discipline as doctor's export):
//
//   1. sessionQuery service (preferred, DSH 0.2.1+): `listSessions()` returns
//      live-preferred records shaped `{ header, live, persisted }` where
//      `header` carries id/createdAt/cwd/agentPreset/origin — exact cwd
//      equality, subagent children excluded. Titles come from `readTitle()`.
//   2. sessionPersistence service (legacy fallback): 0.1.x returned flat
//      headers; 0.2.1 returns `{ header, formatStatus, revision, sizeBytes }`.
//      `normalizeSessionHeader` accepts BOTH shapes, so a host that only
//      mounts persistence still enumerates.
//   3. filesystem scan (last resort): <DSH_HOME>/sessions/<projectKey(cwd)>/
//      <encoded-id>/ session log, decoded + mtime-sorted. The log filename is
//      a GENERATION name — v0 is `session.jsonl[.zstd]`, later generations are
//      `session.vN.jsonl[.zstd]` (0.2.1 writes `session.v4.jsonl.zstd`); the
//      newest canonical generation is picked, like the host's own `open()`.
//      The projectKey encoding is ported VERBATIM from
//      dsh-session-persistence-jsonl (lossy by design — separators collapse,
//      unsafe code units escape as ~XXXX) so the scan lands in exactly the
//      directory DSH writes.
//
// Harness-agnostic: services are injected as narrow structural interfaces.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Header-like row of the DSH persistence/query services (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
	title?: string;
	/** Timestamp fallback some hosts carry on the header. */
	updatedAt?: number;
}

/**
 * Listing row of `sessionPersistence.list()` (0.2.1) /
 * `sessionQuery.listSessions()`: `{ header, live?, persisted?, … }`.
 * 0.1.x returned the flat header itself; both shapes are accepted.
 */
export interface SessionRecordLike {
	header?: SessionHeaderLike;
	live?: boolean;
	persisted?: boolean;
}

/** Structural slice of the 0.2.1 `sessionQuery` service. */
export interface SessionQuerySource {
	listSessions(signal?: AbortSignal): Promise<readonly unknown[]>;
	/** 0.2.1 returns the title string; some hosts return `{ title }`. */
	readTitle?(sessionId: string, signal?: AbortSignal): Promise<unknown>;
	/** 0.2.1: `{ session, inheritedEventCount, events }`. */
	readSession?(sessionId: string): Promise<{ events?: readonly unknown[] } | undefined>;
	/** Lightweight records (no `data` on 0.2.1); accepted for title folding. */
	listEvents?(sessionId: string): Promise<readonly unknown[] | { events?: readonly unknown[] }>;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service/query) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service/query sources. */
	preset?: string;
	/** Human-readable session title (if available). */
	title?: string;
	source: "query" | "service" | "scan";
}

export interface PersistenceListSource {
	/** 0.1.x flat headers OR 0.2.1 `{ header }` rows — both normalized. */
	list(signal?: AbortSignal): Promise<readonly unknown[]>;
	/** Legacy pre-0.2.1 readers (removed from 0.2.1's sessionPersistence). */
	inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
	readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
}


export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live 0.2.1 sessionQuery service (preferred enumeration + titles). */
	query?: SessionQuerySource;
	/** live sessionPersistence service (legacy fallback — scan otherwise). */
	persistence?: PersistenceListSource;
	/** Optional title resolver for session ids. */
	titleFor?: (sessionId: string) => string | undefined;
	/** ids to hide (e.g. this conversation's CURRENT session). */
	exclude?: string[];
	/** cap (default 10). */
	limit?: number;
}

/**
 * Extract a human-readable title from a session's events:
 * 1. session/title event (highest precedence)
 * 2. first user message text (deterministic fallback)
 */
export function extractTitleFromEvents(events: readonly unknown[]): string | undefined {
	if (!Array.isArray(events) || events.length === 0) return undefined;
	// 1. Look for explicit session/title event from the end
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i] as { type?: string; data?: { title?: string } };
		if (ev?.type === "session/title" && ev.data?.title) {
			const t = ev.data.title.trim();
			if (t) return t.slice(0, 36);
		}
	}
	// 2. Look for first human text-bearing user message
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as {
			type?: string;
			data?: {
				source?: { kind?: string };
				content?: Array<{ type?: string; text?: string }>;
			};
		};
		if (ev?.type === "user/message") {
			const text = (ev.data?.content ?? [])
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text?.trim())
				.filter(Boolean)
				.join(" ");
			if (text) {
				const clean = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim();
				const candidate = clean || text;
				const oneLine = candidate.replace(/[\r\n\t]+/g, " ").trim();
				if (oneLine) return oneLine.slice(0, 36);
			}
		}
	}
	return undefined;
}

/**
 * Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
 * `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
 * else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
 * readable part bounded to 251 chars and `root` when empty.
 */
export function projectKeyOf(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i] as string;
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Decode an encoded session dir name (`~003A` → `:` etc.). */
export function decodeSessionDirName(name: string): string {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/**
 * Port of the host's `encodeSegment` — the per-session directory name.
 * Safe code units (`A-Za-z0-9._-`) stay literal and EVERY other UTF-16 code
 * unit becomes `~XXXX` uppercase hex, `~` itself included (`~007E`); `.`/`..`
 * are special-cased so a whole segment cannot traverse upward. Used by
 * doctor's on-disk log fallback (a lark-link id `lark-link:dm:oc_x:0` encodes
 * to `lark-link~003Adm~003Aoc_x~003A0`).
 */
export function encodeSessionDirName(segment: string): string {
	if (segment.length === 0) throw new Error("cannot encode an empty session id");
	if (segment === ".") return "~002E";
	if (segment === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] as string;
		out +=
			ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)
				? ch
				: `~${segment.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}

/**
 * Canonical generation log filenames (dsh-session-format):
 *   v0 → `session.jsonl[.zstd]`
 *   vN → `session.vN.jsonl[.zstd]`  (N ≥ 1, no leading zeros)
 * Temporary / uppercase / `.v0` names are not canonical (same rule as
 * src/wechat/dsh/session-log.cjs).
 */
const GENERATION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u;

/** Parse a canonical generation log filename → version (0 = untagged), or undefined. */
export function parseGenerationLogFilename(filename: string): number | undefined {
	const match = GENERATION_LOG_NAME.exec(filename);
	if (!match) return undefined;
	if (match[1] === undefined) return 0;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) ? version : undefined;
}

/**
 * Locate the current session log inside one session directory. Mirrors host
 * `open()`: pick the highest canonical generation (0.1.5+ writes
 * `session.vN.jsonl.zstd`; a migrated session keeps its older generation as an
 * immutable predecessor, so reading the untagged v0 file would miss events).
 * Read-only: returns undefined when the directory has no canonical log.
 */
export function findSessionLogFile(sessionDir: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(sessionDir);
	} catch {
		return undefined;
	}
	let bestVersion = -1;
	let bestName: string | undefined;
	for (const name of names) {
		const version = parseGenerationLogFilename(name);
		if (version === undefined) continue;
		// Highest generation wins; on a tie prefer the compressed artifact
		// (the host's default) over a stale plaintext leftover.
		if (version > bestVersion || (version === bestVersion && name.endsWith(".zstd"))) {
			bestVersion = version;
			bestName = name;
		}
	}
	return bestName === undefined ? undefined : join(sessionDir, bestName);
}

interface SessionLogFrame {
	start: number;
	end: number;
}

interface SessionLogRuntime {
	scanZstdFrames(buffer: Uint8Array, maxFrames?: number): unknown;
}

let sessionLogRuntime: Promise<SessionLogRuntime | undefined> | undefined;

/**
 * Lazily reuse the WeChat half's battle-tested Zstandard frame scanner
 * (`src/wechat/dsh/session-log.cjs`) instead of keeping a second copy. The
 * import is local/relative so the bundler keeps it in-process; a host without
 * it degrades to whole-file decompression.
 */
function loadSessionLogRuntime(): Promise<SessionLogRuntime | undefined> {
	sessionLogRuntime ??= import("../wechat/dsh/session-log.cjs")
		.then((module) => module as unknown as SessionLogRuntime)
		.catch(() => undefined);
	return sessionLogRuntime;
}

/**
 * Decode one session log artifact to JSONL text. DSH appends one Zstandard
 * FRAME per commit, and `zlib.zstdDecompressSync` stops after the FIRST frame
 * when handed a concatenated stream — so frames are decompressed one by one
 * (plain `.jsonl` passes through untouched). Undecodable frames are skipped,
 * mirroring the host's tolerant reader. Used by doctor's export fallback.
 */
export async function readSessionLogJsonl(file: string): Promise<string> {
	const buffer = readFileSync(file);
	if (!file.endsWith(".zstd")) return buffer.toString("utf8");
	const runtime = await loadSessionLogRuntime();
	if (!runtime) return zstdDecompressSync(buffer).toString("utf8");
	const scanned = runtime.scanZstdFrames(buffer) as {
		frames?: SessionLogFrame[];
		tornStart?: number;
	};
	const frames = Array.isArray(scanned?.frames) ? scanned.frames : [];
	if (frames.length === 0) {
		try {
			return zstdDecompressSync(buffer).toString("utf8");
		} catch {
			return "";
		}
	}
	const parts: string[] = [];
	for (const frame of frames) {
		try {
			parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8"));
		} catch {
			// torn / unreadable frame — skip it
		}
	}
	return parts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize one listing row to a header. Accepts BOTH host shapes:
 * - DSH 0.2.1: `{ header: { id, createdAt, cwd, … }, live, persisted }`
 * - DSH 0.1.x: a flat header `{ id, createdAt, cwd, … }`
 * Returns undefined when the row carries no usable id (defensive: a service
 * row whose header failed to load must not become an `undefined` session).
 */
export function normalizeSessionHeader(row: unknown): SessionHeaderLike | undefined {
	if (!isRecord(row)) return undefined;
	const header = isRecord(row.header) ? row.header : row;
	const id = nonEmptyString(header.id);
	if (id === undefined) return undefined;
	const createdAt =
		typeof header.createdAt === "number" && Number.isFinite(header.createdAt)
			? header.createdAt
			: typeof header.updatedAt === "number" && Number.isFinite(header.updatedAt)
				? header.updatedAt
				: 0;
	const cwd = nonEmptyString(header.cwd);
	const origin = nonEmptyString(header.origin);
	const agentPreset = nonEmptyString(header.agentPreset);
	const title = nonEmptyString(header.title);
	return {
		id,
		createdAt,
		...(cwd === undefined ? {} : { cwd }),
		...(origin === undefined ? {} : { origin }),
		...(agentPreset === undefined ? {} : { agentPreset }),
		...(title === undefined ? {} : { title }),
	};
}

/** `sessionQuery.readTitle` returns a bare string on 0.2.1 and `{ title }` on some builds. */
function titleFromQueryResult(result: unknown): string | undefined {
	if (typeof result === "string") return result.trim() || undefined;
	if (isRecord(result)) return nonEmptyString(result.title);
	return undefined;
}

/** `listEvents` returns records on current hosts and `{ events }` on some builds. */
function eventsFromListResult(result: unknown): readonly unknown[] | undefined {
	if (Array.isArray(result)) return result;
	if (isRecord(result) && Array.isArray(result.events)) return result.events;
	return undefined;
}

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows: WorkspaceSessionInfo[] = [];

	// Project one listing (0.2.1 `{ header }` records or legacy flat headers)
	// onto this workspace: exact cwd equality, subagent children excluded.
	const collect = (
		raw: readonly unknown[],
		source: WorkspaceSessionInfo["source"],
	): WorkspaceSessionInfo[] =>
		raw
			.map(normalizeSessionHeader)
			.filter((header): header is SessionHeaderLike => header !== undefined)
			.filter(
				(header) =>
					header.cwd === deps.cwd &&
					header.origin !== "subagent" &&
					!exclude.has(header.id),
			)
			.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
			.slice(0, limit)
			.map<WorkspaceSessionInfo>((header) => ({
				id: header.id,
				createdAt: header.createdAt,
				...(header.agentPreset ? { preset: header.agentPreset } : {}),
				...(header.title ? { title: header.title } : {}),
				source,
			}));

	// Source 1: 0.2.1 sessionQuery — live-preferred cloned headers.
	if (deps.query?.listSessions) {
		try {
			rows = collect(await deps.query.listSessions(), "query");
		} catch {
			// fall through to persistence / scan
		}
	}

	// Source 2: sessionPersistence.list() — legacy mount, or a host where
	// sessionQuery is absent. 0.2.1 rows are `{ header }`, 0.1.x rows are flat.
	if (rows.length === 0 && deps.persistence?.list) {
		try {
			rows = collect(await deps.persistence.list(), "service");
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 3: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/, newest
	// canonical generation log per session directory (v0 … v4+).
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const log = findSessionLogFile(join(dir, name));
				if (log === undefined) continue; // no materialized log — not resumable
				let mtime: number;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue;
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id);
				rows.push({ id, createdAt: mtime, ...(title ? { title } : {}), source: "scan" });
			}
			rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
			rows = rows.slice(0, limit);
		}
	}

	// Resolve missing titles, cheapest source first: the caller's live resolver,
	// then 0.2.1 sessionQuery (`readTitle`, `readSession`, `listEvents`), then
	// the legacy persistence readers. Never fatal — a title is cosmetic.
	if (rows.length > 0) {
		const query = deps.query;
		await Promise.allSettled(
			rows.map(async (row) => {
				if (row.title) return;
				if (deps.titleFor) {
					const resolved = deps.titleFor(row.id);
					if (resolved) {
						row.title = resolved;
						return;
					}
				}
				if (query) {
					try {
						if (query.readTitle) {
							const titled = titleFromQueryResult(await query.readTitle(row.id));
							if (titled) {
								row.title = titled;
								return;
							}
						}
						let events: readonly unknown[] | undefined;
						if (query.readSession) {
							events = (await query.readSession(row.id))?.events;
						}
						if (events === undefined && query.listEvents) {
							events = eventsFromListResult(await query.listEvents(row.id));
						}
						if (events) {
							const extracted = extractTitleFromEvents(events);
							if (extracted) {
								row.title = extracted;
								return;
							}
						}
					} catch {
						// best-effort
					}
				}
				if (!deps.persistence) return;
				try {
					let events: readonly unknown[] | undefined;
					if (deps.persistence.inspect) {
						const res = await deps.persistence.inspect(row.id);
						events = res?.events;
					} else if (deps.persistence.load) {
						const res = await deps.persistence.load(row.id);
						events = res?.events;
					} else if (deps.persistence.readFrom) {
						const res = await deps.persistence.readFrom(row.id, 0);
						events = res?.events;
					}
					if (events) {
						const extracted = extractTitleFromEvents(events);
						if (extracted) row.title = extracted;
					}
				} catch {
					// best-effort
				}
			}),
		);
	}

	return rows;
}


// ---- saved workspaces (/ws) ------------------------------------------------
//
// `/ws add|use|remove|list` manages a small FAVOURITES list of working
// directories, kept at <DSH_HOME>/lark-link/workspaces.json (the same state
// directory as the rest of the bridge). It is deliberately separate from the
// per-conversation override store: `/ws add` only SAVES a path, `/ws use` and
// `/cd` are what switch the conversation (and those go through the existing
// /workspace handler so the per-conversation override + session rotation stay
// in one place).

export interface SavedWorkspaceEntry {
	/** Absolute, normalized path. */
	path: string;
	/** Optional short label (the card falls back to the basename). */
	label?: string;
	addedAt: number;
	lastUsedAt?: number;
}

export interface SavedWorkspaceStore {
	/** The backing file (exposed for /ws status output and tests). */
	file(): string;
	/** Saved workspaces in ADD order — the order /ws list numbers them. */
	list(): SavedWorkspaceEntry[];
	has(path: string): boolean;
	add(
		path: string,
		label?: string,
	): { added: boolean; entry: SavedWorkspaceEntry; index: number };
	remove(path: string): boolean;
	touch(path: string): void;
}

/** `<DSH_HOME>/lark-link/workspaces.json` (`~/.dsh` when DSH_HOME is unset). */
export function defaultWorkspacesFile(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(
		env.DSH_HOME ?? join(homedir(), ".dsh"),
		"lark-link",
		"workspaces.json",
	);
}

/** True when `p` looks like a Windows drive/UNC path. */
function isWinShaped(p: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/**
 * Normalize a saved path: trim, platform-correct normalize, drop trailing
 * separators (except a bare root). Keeps the Windows shape on every host so a
 * path typed into a Windows-hosted bridge is stored verbatim.
 */
export function normalizeWorkspacePath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "";
	const normalized = isWinShaped(trimmed)
		? win32.normalize(trimmed)
		: posix.normalize(trimmed);
	const stripped =
		normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
	// "D:\\" normalizes to itself; stripping its separator would turn it into
	// the drive-RELATIVE "D:" — a different (and meaningless) path.
	return /^[A-Za-z]:$/.test(stripped) ? normalized : stripped;
}

/** Case/separator-insensitive comparison (case folds only for Windows paths). */
export function sameWorkspacePath(a: string, b: string): boolean {
	const na = normalizeWorkspacePath(a);
	const nb = normalizeWorkspacePath(b);
	if (!na || !nb) return false;
	return isWinShaped(na) || isWinShaped(nb)
		? na.toLowerCase() === nb.toLowerCase()
		: na === nb;
}

/**
 * Resolve a `/ws use|remove` argument: a 1-based number matching /ws list, or
 * an exact path. Returns undefined when it matches nothing.
 */
export function findSavedWorkspace(
	entries: readonly SavedWorkspaceEntry[],
	ref: string,
): { entry: SavedWorkspaceEntry; index: number } | undefined {
	const needle = ref.trim();
	if (!needle) return undefined;
	if (/^\d+$/.test(needle)) {
		const index = Number(needle) - 1;
		const entry = entries[index];
		return entry ? { entry, index } : undefined;
	}
	const index = entries.findIndex(
		(entry) => sameWorkspacePath(entry.path, needle),
	);
	return index === -1 ? undefined : { entry: entries[index] as SavedWorkspaceEntry, index };
}

interface PersistedWorkspaces {
	version?: number;
	workspaces?: unknown[];
}

/**
 * JSON-file backed saved-workspace store.
 *
 * Load is lazy and tolerant (missing/corrupt file = empty list, never a
 * crash); persist is best-effort (a read-only state dir must not break /ws
 * use — the in-memory list still works for the session). Writes go through a
 * temp file + rename so a crash mid-write cannot truncate the list.
 */
export function createSavedWorkspaceStore(
	file: string,
	now: () => number = Date.now,
): SavedWorkspaceStore {
	let entries: SavedWorkspaceEntry[] | undefined;

	const load = (): SavedWorkspaceEntry[] => {
		if (entries) return entries;
		const loaded: SavedWorkspaceEntry[] = [];
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
			const rows = Array.isArray(raw)
				? raw
				: (raw as PersistedWorkspaces | null)?.workspaces;
			if (Array.isArray(rows)) {
				for (const row of rows) {
					const rec = row as Partial<SavedWorkspaceEntry> | undefined;
					if (!rec || typeof rec.path !== "string") continue;
					const path = normalizeWorkspacePath(rec.path);
					if (!path || loaded.some((e) => sameWorkspacePath(e.path, path))) continue;
					loaded.push({
						path,
						...(typeof rec.label === "string" && rec.label.trim()
							? { label: rec.label.trim() }
							: {}),
						addedAt: typeof rec.addedAt === "number" ? rec.addedAt : now(),
						...(typeof rec.lastUsedAt === "number"
							? { lastUsedAt: rec.lastUsedAt }
							: {}),
					});
				}
			}
		} catch {
			// first run / unreadable file — start empty
		}
		entries = loaded;
		return entries;
	};

	const persist = (rows: SavedWorkspaceEntry[]): void => {
		try {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: 1, workspaces: rows }, null, 2), {
				mode: 0o600,
			});
			renameSync(tmp, file);
		} catch {
			// read-only state dir: keep the in-memory list, do not fail the command
		}
	};

	return {
		file: () => file,
		list: () => load().map((entry) => ({ ...entry })),
		has(path) {
			const target = normalizeWorkspacePath(path);
			return load().some((entry) => sameWorkspacePath(entry.path, target));
		},
		add(path, label) {
			const rows = load();
			const target = normalizeWorkspacePath(path);
			const existing = rows.findIndex((entry) => sameWorkspacePath(entry.path, target));
			if (existing !== -1) {
				return { added: false, entry: { ...(rows[existing] as SavedWorkspaceEntry) }, index: existing };
			}
			const entry: SavedWorkspaceEntry = {
				path: target,
				...(label && label.trim() ? { label: label.trim() } : {}),
				addedAt: now(),
			};
			rows.push(entry);
			persist(rows);
			return { added: true, entry: { ...entry }, index: rows.length - 1 };
		},
		remove(path) {
			const rows = load();
			const target = normalizeWorkspacePath(path);
			const index = rows.findIndex((entry) => sameWorkspacePath(entry.path, target));
			if (index === -1) return false;
			rows.splice(index, 1);
			persist(rows);
			return true;
		},
		touch(path) {
			const rows = load();
			const target = normalizeWorkspacePath(path);
			const entry = rows.find((row) => sameWorkspacePath(row.path, target));
			if (!entry) return;
			entry.lastUsedAt = now();
			persist(rows);
		},
	};
}
