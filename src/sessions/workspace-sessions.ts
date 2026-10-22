// Workspace session listing for the Feishu-side /resume command, plus the
// saved-workspace store behind /ws (list|add|use|remove|status).
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Two layered sources (same discipline as doctor's export):
//
//   1. sessionPersistence service (preferred): headers carry createdAt, cwd,
//      agentPreset and origin — exact cwd equality, subagent children excluded.
//   2. filesystem scan (fallback): <DSH_HOME>/sessions/<projectKey(cwd)>/<encoded-id>/
//      session.jsonl.zstd, decoded + mtime-sorted. The projectKey encoding is
//      ported VERBATIM from dsh-session-persistence-jsonl (lossy by design —
//      separators collapse, unsafe code units escape as ~XXXX) so the scan
//      lands in exactly the directory DSH writes.
//
// Harness-agnostic: the service is injected as a narrow structural interface.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

/** Header-like row of the DSH sessionPersistence service (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
	title?: string;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service source only. */
	preset?: string;
	/** Human-readable session title (if available). */
	title?: string;
	source: "service" | "scan";
}

export interface PersistenceListSource {
	list(signal?: AbortSignal): Promise<SessionHeaderLike[]>;
	inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
	readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
}


export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live sessionPersistence service (optional — scan fallback otherwise). */
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

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows: WorkspaceSessionInfo[] = [];

	// Source 1: the persistence service — headers give exact cwd + origin.
	if (deps.persistence?.list) {
		try {
			const headers = await deps.persistence.list();
			rows = headers
				.filter(
					(h) =>
						h.cwd === deps.cwd &&
						h.origin !== "subagent" &&
						!exclude.has(h.id),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit)
				.map<WorkspaceSessionInfo>((h) => {
					const title = deps.titleFor?.(h.id) ?? h.title;
					return {
						id: h.id,
						createdAt: h.createdAt,
						...(h.agentPreset ? { preset: h.agentPreset } : {}),
						...(title ? { title } : {}),
						source: "service",
					};
				});
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 2: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/.
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const log = join(dir, name, "session.jsonl.zstd");
				let mtime: number;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue; // no materialized log — not resumable
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id);
				rows.push({ id, createdAt: mtime, ...(title ? { title } : {}), source: "scan" });
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}

	// Resolve titles from persistence events if not already present
	if (deps.persistence && rows.length > 0) {
		await Promise.allSettled(
			rows.map(async (row) => {
				if (row.title) return;
				if (deps.titleFor) {
					const t = deps.titleFor(row.id);
					if (t) {
						row.title = t;
						return;
					}
				}
				try {
					let events: readonly unknown[] | undefined;
					if (deps.persistence?.inspect) {
						const res = await deps.persistence.inspect(row.id);
						events = res?.events;
					} else if (deps.persistence?.load) {
						const res = await deps.persistence.load(row.id);
						events = res?.events;
					} else if (deps.persistence?.readFrom) {
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
