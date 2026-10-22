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
		workspaces?: Record<string, { path?: string; title?: string } | undefined>;
	};
}

/** DSH home directory (same resolution as the bridge state dir). */
export function dshHomeDir(): string {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * The workspace the GUI most recently used, or undefined when it cannot be
 * determined (fresh install, unreadable/legacy store).
 */
export function detectDefaultWorkspaceRoot(): string | undefined {
	try {
		const file = join(dshHomeDir(), "storages", "workspace.json");
		if (!existsSync(file)) return undefined;
		const store = JSON.parse(readFileSync(file, "utf8")) as WorkspaceStoreShape;
		const workspaces = store.tables?.workspaces;
		if (!workspaces) return undefined;
		const id =
			store.global?.defaultWorkspaceId ?? store.global?.workspaceIds?.[0];
		const preferred = id ? workspaces[id]?.path : undefined;
		if (preferred && existsSync(preferred)) return preferred;
		// The default id may point at a removed directory; take the most
		// recently registered surviving workspace instead.
		const entries = Object.values(workspaces).filter(
			(entry): entry is { path?: string } => Boolean(entry),
		);
		for (let i = entries.length - 1; i >= 0; i--) {
			const path = entries[i]?.path;
			if (path && existsSync(path)) return path;
		}
	} catch {
		// best-effort only — fall back to cwd
	}
	return undefined;
}
