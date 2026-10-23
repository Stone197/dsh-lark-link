// Persistent bridge diagnostics log.
//
// The desktop DSH host does not capture plugin stdout, so session/recovery
// failures (e.g. "resume failed → fresh session") were invisible. Every
// diagnostic event is appended as one JSON line to `<bridge state>/bridge.log`
// (rotated at 8 MB). It is intentionally small and redaction-free: only ids,
// counts, and error messages are written — never message text or credentials.

import {
	appendFileSync,
	mkdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface BridgeLog {
	/** Append one diagnostic event. Never throws. */
	event(name: string, data?: Record<string, unknown>): void;
	/** Absolute log path (for `/doctor` / support replies). */
	readonly path: string;
}

const MAX_BYTES = 8 * 1024 * 1024;

export function createBridgeLog(stateDir: string): BridgeLog {
	const file = join(stateDir, "bridge.log");
	const event = (name: string, data?: Record<string, unknown>): void => {
		try {
			mkdirSync(dirname(file), { recursive: true });
			const line = `${JSON.stringify({
				at: new Date().toISOString(),
				event: name,
				...(data ?? {}),
			})}\n`;
			appendFileSync(file, line, { mode: 0o600 });
			if (statSync(file).size > MAX_BYTES) {
				try {
					renameSync(file, `${file}.1`);
				} catch {
					// keep appending even if rotation fails
				}
			}
		} catch {
			// diagnostics must never break the bridge
		}
	};
	return { event, path: file };
}
