// Type declarations for `session-log.cjs` (ported from pan17/dsh-wechat
// v0.13.3, MIT). The implementation stays CommonJS because it replaces the
// host's own log scanner and is `require()`d by tests; this .d.cts gives the
// TypeScript side the module's public surface under NodeNext.
//
// Only the four "read" entry points are consumed by the bridge (see
// `dsh/ops.ts`); the rest are exported for tests and diagnostics.

export const COMPRESSED_SUFFIX: string;

export interface SessionListFacts {
	preset?: string;
	title?: string;
	lastUserMessageTime?: number;
}

export type SessionUsedHint =
	| { status: "used"; time?: number }
	| { status: "blank" }
	| { status: "unknown" };

export function clearSessionLogCache(): void;
export function encodeSegment(segment: string): string;
export function locateSessionLog(
	cwd: string,
	sessionId: string,
	root?: string,
): string | undefined;
export function parseGenerationLogFilename(filename: string): unknown;
export function projectKey(cwd: string): string;
export function readSessionEvents(
	cwd: string,
	sessionId: string,
	root?: string,
): unknown[];
export function readSessionListFacts(
	cwd: string,
	sessionId: string,
	root?: string,
): SessionListFacts;
export function readSessionRecency(
	cwd: string,
	sessionId: string,
	root?: string,
): number | undefined;
export function readSessionRuntimePreset(
	cwd: string,
	sessionId: string,
	root?: string,
): string | undefined;
export function readSessionUsedHint(
	cwd: string,
	sessionId: string,
	root?: string,
): SessionUsedHint;
export function resolveDshHome(configured?: string): string;
export function scanZstdFrames(buffer: Uint8Array, maxFrames?: number): unknown[];
export function sessionLogPath(cwd: string, sessionId: string, root?: string): string;
