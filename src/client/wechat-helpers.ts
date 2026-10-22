// WeChat settings panel — pure, DOM-free helpers.
//
// Extracted VERBATIM in behaviour from pan17/dsh-wechat's `src/client.js`
// (MIT, the "指令帮助"/settings panel half) when the WeChat panel was folded
// into this repository's single client bundle (dist/client.js). The component
// tree lives in `wechat-section.ts`; everything here is plain data mapping so
// it can be unit-tested in Node without React or a DOM.
//
// Contract kept from the original panel:
//   - HTTP prefix /wechat/api/* (the host registers the routes);
//   - localStorage keys dsh-wechat/settings-open, dsh-wechat/help-open
//     (per-browser collapse state, never persisted host-side);
//   - the exact body posted to /wechat/api/config (`payloadOf`) — a field
//     missing from it silently saves nothing while the panel still reports
//     success.

/** localStorage key holding the set of expanded group ids. */
export const OPEN_KEY = "dsh-wechat/settings-open";
/** localStorage key holding whether the 指令帮助 sheet was left open. */
export const HELP_OPEN_KEY = "dsh-wechat/help-open";

/** One command entry of the host's help catalog (see src/help/catalog.ts). */
export interface WechatHelpCommand {
	id: string;
	command: string;
	aliases: string[];
	summary: string;
	usage: string;
	examples: Array<{ line: string; note: string }>;
	group: string;
}

/** The `catalog` part of `/wechat/api/help`. */
export interface WechatHelpCatalog {
	intro: string;
	footer: string;
	groups: Array<{ id: string; title: string; blurb: string }>;
	commands: WechatHelpCommand[];
}

/** Editable fields of the WeChat settings panel (all strings, as typed). */
export interface WechatFormState {
	cwd: string;
	cardTimeoutMs: string;
	crossSessionNotify: boolean;
	notifyTaskEvents: boolean;
	surfacePromptEnabled: boolean;
	surfacePrompt: string;
	silent: boolean;
	finalOnly: boolean;
	mergeEnabled: boolean;
	mergeSilenceMs: string;
	mergeMaxMsgs: string;
	mergeForcedReleaseMs: string;
	mergeSuffixTokens: boolean;
	mediaMergeEnabled: boolean;
	mediaHoldMs: string;
	mediaAtRefEnabled: boolean;
	allowRemotePermissionEscalation: boolean;
	allowAnyFilePath: boolean;
	maxOutgoingFileBytes: string;
	sendWechatRateLimitPerMinute: string;
	allowedUsers: string;
}

/** `/wechat/api/status` body (only the fields the panel renders). */
export interface WechatStatusPayload {
	phase?: string;
	monitorRunning?: boolean;
	botId?: string;
	userCount?: number;
	error?: string;
	qrUrl?: string;
	users?: Array<{ silent?: boolean }>;
	config?: Record<string, unknown>;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface FetchLike {
	(url: string, init?: Record<string, unknown>): Promise<{
		ok: boolean;
		status: number;
		json(): Promise<unknown>;
	}>;
}

function browserStorage(): StorageLike | undefined {
	const browser = globalThis as {
		window?: { localStorage?: StorageLike };
	};
	return browser.window?.localStorage;
}

/** Read one JSON value from localStorage. Storage failures are non-fatal. */
export function readStore<T = unknown>(key: string): T | null {
	try {
		const storage = browserStorage();
		if (!storage) return null;
		const raw = storage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export function writeStore(key: string, value: unknown): void {
	try {
		const storage = browserStorage();
		if (!storage) return;
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode / quota: the control still works, it just does not
		// remember across reloads.
	}
}

/** Expanded group ids, read once per mount. */
export function loadOpenGroups(): Record<string, boolean> {
	const parsed = readStore<Record<string, boolean>>(OPEN_KEY);
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function storeOpenGroups(next: Record<string, boolean>): void {
	writeStore(OPEN_KEY, next);
}

/** Whether 指令帮助 was left expanded; a settings page that forgets this
 * re-collapses under the user every time they come back. */
export function loadHelpOpen(): boolean {
	return readStore<boolean>(HELP_OPEN_KEY) === true;
}

export function storeHelpOpen(open: boolean): void {
	writeStore(HELP_OPEN_KEY, !!open);
}

/** One host API call under the fixed `/wechat/api/*` prefix. */
export async function api(
	path: string,
	options: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
	const doFetch = (globalThis as { fetch?: FetchLike }).fetch;
	if (!doFetch) throw new Error("fetch unavailable in this client runtime");
	const resp = await doFetch(`/wechat/api${path}`, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	let body: Record<string, unknown> = {};
	try {
		const parsed = await resp.json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = parsed as Record<string, unknown>;
		}
	} catch {
		// non-JSON error page — keep the empty body
	}
	return { ok: resp.ok, status: resp.status, body };
}

/**
 * The exact body posted to `/wechat/api/config`.
 *
 * Kept as one pure function of `form` for two reasons: the dirty marker has to
 * compare like-for-like with what Save would send, and a field that is missing
 * here silently saves nothing while the panel still reports success.
 */
export function payloadOf(form: WechatFormState): Record<string, unknown> {
	const numberOrUndefined = (value: string): number | undefined =>
		value.trim() === "" ? undefined : Number(value);
	return {
		cwd: form.cwd.trim(),
		cardTimeoutMs: Number(form.cardTimeoutMs) || undefined,
		crossSessionNotify: !!form.crossSessionNotify,
		notifyTaskEvents: !!form.notifyTaskEvents,
		silent: !!form.silent,
		finalOnly: !!form.finalOnly,
		mergeEnabled: !!form.mergeEnabled,
		mergeSuffixTokens: !!form.mergeSuffixTokens,
		mediaMergeEnabled: !!form.mediaMergeEnabled,
		mediaAtRefEnabled: !!form.mediaAtRefEnabled,
		allowRemotePermissionEscalation: !!form.allowRemotePermissionEscalation,
		allowAnyFilePath: !!form.allowAnyFilePath,
		// Same blank-means-undefined rule as the rate limit: an empty box must
		// leave the stored value alone instead of sending 0 (which is
		// meaningful for mergeSilenceMs).
		mergeSilenceMs: numberOrUndefined(form.mergeSilenceMs),
		mergeMaxMsgs: numberOrUndefined(form.mergeMaxMsgs),
		mergeForcedReleaseMs: numberOrUndefined(form.mergeForcedReleaseMs),
		mediaHoldMs: numberOrUndefined(form.mediaHoldMs),
		maxOutgoingFileBytes: numberOrUndefined(form.maxOutgoingFileBytes),
		// An empty string must NOT become 0 (which means "unlimited") —
		// `Number("")` is 0, so the blank case is mapped to undefined and the
		// stored value is left alone.
		sendWechatRateLimitPerMinute: numberOrUndefined(
			form.sendWechatRateLimitPerMinute,
		),
		allowedUsers: form.allowedUsers
			.split(/[\n,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry !== ""),
		surfacePromptEnabled: !!form.surfacePromptEnabled,
		surfacePrompt: form.surfacePrompt,
	};
}

export const onOff = (value: unknown): string => (value ? "开" : "关");

export function minutes(ms: unknown): string {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) return "未设置";
	return n % 60000 === 0 ? `${n / 60000} 分钟` : `${Math.round(n / 1000)} 秒`;
}

export function bytes(value: unknown): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "未设置";
	if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
	return `${Math.round(n / 1024)} KiB`;
}

/** Allowlist size as the user sees it: blank means "no restriction". */
export function allowlistSummary(raw: string): string {
	const ids = String(raw || "")
		.split(/[\n,]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return ids.length === 0 ? "白名单 不限" : `白名单 ${ids.length} 个`;
}

/** The tooltip body for one command row: first two examples plus a count. */
export function tooltipFor(entry: WechatHelpCommand): string {
	const shown = entry.examples.slice(0, 2);
	const lines = shown.map((example) => `${example.line}  —  ${example.note}`);
	if (entry.examples.length > shown.length) {
		lines.push(`共 ${entry.examples.length} 条示例，展开查看全部`);
	}
	return lines.join("\n");
}

// ── Collapsed-group summaries (derived from live form state) ─────────────

export function summarizeMerge(form: WechatFormState | null): string {
	if (!form) return "";
	return form.mergeEnabled
		? `已开启 · 静默 ${form.mergeSilenceMs || "?"}ms · 上限 ${form.mergeMaxMsgs || "?"} 条 · 强制 ${minutes(form.mergeForcedReleaseMs)}`
		: "已关闭 · 每条消息各自一轮";
}

export function summarizeDelivery(form: WechatFormState | null): string {
	if (!form) return "";
	return `静默 ${onOff(form.silent)} · 结论 ${onOff(form.finalOnly)} · 决策推送 ${onOff(form.crossSessionNotify)} · 任务提醒 ${onOff(form.notifyTaskEvents)}`;
}

export function summarizeMedia(form: WechatFormState | null): string {
	if (!form) return "";
	return form.mediaMergeEnabled
		? `合并 开 · 等待 ${minutes(form.mediaHoldMs)} · ${form.mediaAtRefEnabled ? "@引用" : "路径"}`
		: `合并 关 · 附件各自一轮 · ${form.mediaAtRefEnabled ? "@引用" : "路径"}`;
}

export function summarizeConnection(form: WechatFormState | null): string {
	if (!form) return "";
	return `${form.cwd || "未设置目录"} · 卡片 ${minutes(form.cardTimeoutMs)} · 限流 ${form.sendWechatRateLimitPerMinute || "不限"}/分 · ${allowlistSummary(form.allowedUsers)}`;
}

export function summarizePrompt(form: WechatFormState | null): string {
	if (!form) return "";
	return form.surfacePromptEnabled
		? `已开启 · ${form.surfacePrompt.trim().length} 字`
		: "已关闭 · 不注入";
}

export function summarizeSecurity(form: WechatFormState | null): string {
	if (!form) return "";
	const relaxed = [
		form.allowRemotePermissionEscalation ? "远程放宽权限" : "",
		form.allowAnyFilePath ? "任意路径发送" : "",
	].filter(Boolean);
	const tail = `文件上限 ${bytes(form.maxOutgoingFileBytes)}`;
	return relaxed.length
		? `已放宽：${relaxed.join("、")} · ${tail}`
		: `默认收紧 · ${tail}`;
}
