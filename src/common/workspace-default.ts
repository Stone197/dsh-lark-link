// Default workspace for bridge sessions.
//
// A desktop DSH process starts with its cwd set to the PROFILE directory
// (`~/.dsh/profiles/<name>`), which is not a GUI workspace: sessions created
// there do not show up in the conversation list the user is looking at. The
// bridge therefore inherits the workspace the GUI is currently using instead.
//
// Source of truth: the host's workspace store, written by the GUI:
//   <DSH_HOME>/storages/workspace.json
//     .global.defaultWorkspaceId
//     .tables.workspaces[id].path
// When the store is missing/unreadable we fall back to the process cwd (the
// historical behavior) — never throw while booting the bridge.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface WorkspaceStoreShape {
	global?: {
		defaultWorkspaceId?: string;
		workspaceIds?: string[];
	};
	tables?: {
		workspaces?: Record<
			string,
			{ path?: string; title?: string; updatedAt?: string } | undefined
		>;
	};
}

/** DSH home directory (same resolution as the bridge state dir). */
export function dshHomeDir(): string {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * The workspace the GUI is most likely showing, or undefined when it cannot be
 * determined (fresh install, unreadable/legacy store).
 *
 * Order of preference:
 *  1. the workspace updated most recently (`updatedAt`) — i.e. the one the
 *     user is working in right now; bridge sessions created there appear right
 *     next to their current conversation;
 *  2. the GUI's default workspace id;
 *  3. any surviving registered workspace.
 */
export function detectDefaultWorkspaceRoot(): string | undefined {
	try {
		const file = join(dshHomeDir(), "storages", "workspace.json");
		if (!existsSync(file)) return undefined;
		const store = JSON.parse(readFileSync(file, "utf8")) as WorkspaceStoreShape;
		const workspaces = store.tables?.workspaces;
		if (!workspaces) return undefined;
		const entries = Object.entries(workspaces).filter(
			(entry): entry is [string, { path?: string; updatedAt?: string }] =>
				Boolean(entry[1]?.path),
		);
		const live = (path: string | undefined): path is string =>
			typeof path === "string" && existsSync(path);
		// 1. most recently updated workspace
		const recent = entries
			.filter(([, entry]) => live(entry.path))
			.sort(
				(a, b) =>
					Date.parse(b[1].updatedAt ?? "") - Date.parse(a[1].updatedAt ?? ""),
			)[0];
		if (recent && live(recent[1].path)) return recent[1].path;
		// 2. GUI default workspace
		const id =
			store.global?.defaultWorkspaceId ?? store.global?.workspaceIds?.[0];
		const preferred = id ? workspaces[id]?.path : undefined;
		if (live(preferred)) return preferred;
		// 3. any surviving workspace
		for (let i = entries.length - 1; i >= 0; i--) {
			const path = entries[i]?.[1]?.path;
			if (live(path)) return path;
		}
	} catch {
		// best-effort only — fall back to cwd
	}
	return undefined;
}
