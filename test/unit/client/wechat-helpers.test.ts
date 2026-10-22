// WeChat settings panel — pure helper tests.
//
// The panel itself (src/client/wechat-section.ts) is a near-verbatim port of
// pan17/dsh-wechat's client module; its data mapping was extracted into
// src/client/wechat-helpers.ts so the important behaviour (what Save sends,
// what the summaries claim, storage keys, API prefix) is testable in Node
// without React or a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	HELP_OPEN_KEY,
	OPEN_KEY,
	allowlistSummary,
	api,
	bytes,
	loadHelpOpen,
	loadOpenGroups,
	minutes,
	payloadOf,
	readStore,
	storeHelpOpen,
	storeOpenGroups,
	summarizeConnection,
	summarizeDelivery,
	summarizeMedia,
	summarizeMerge,
	summarizePrompt,
	summarizeSecurity,
	tooltipFor,
	writeStore,
	type WechatFormState,
	type WechatHelpCommand,
} from "../../../src/client/wechat-helpers.ts";

function baseForm(overrides: Partial<WechatFormState> = {}): WechatFormState {
	return {
		cwd: "",
		cardTimeoutMs: "",
		crossSessionNotify: false,
		notifyTaskEvents: false,
		surfacePromptEnabled: false,
		surfacePrompt: "",
		silent: false,
		finalOnly: false,
		mergeEnabled: false,
		mergeSilenceMs: "",
		mergeMaxMsgs: "",
		mergeForcedReleaseMs: "",
		mergeSuffixTokens: false,
		mediaMergeEnabled: false,
		mediaHoldMs: "",
		mediaAtRefEnabled: false,
		allowRemotePermissionEscalation: false,
		allowAnyFilePath: false,
		maxOutgoingFileBytes: "",
		sendWechatRateLimitPerMinute: "",
		allowedUsers: "",
		...overrides,
	};
}

// ---- payloadOf (the exact body /wechat/api/config receives) ----------------

test("payloadOf: blank numeric fields stay undefined (never 0)", () => {
	const payload = payloadOf(baseForm());
	for (const key of [
		"mergeSilenceMs",
		"mergeMaxMsgs",
		"mergeForcedReleaseMs",
		"mediaHoldMs",
		"maxOutgoingFileBytes",
		"sendWechatRateLimitPerMinute",
	]) {
		assert.equal(payload[key], undefined, `${key} must be undefined when blank`);
	}
	assert.equal(payload.cardTimeoutMs, undefined);
});

test("payloadOf: numeric fields become numbers; cardTimeoutMs keeps its 0 rule", () => {
	const payload = payloadOf(
		baseForm({
			cardTimeoutMs: "1800000",
			mergeSilenceMs: "0",
			mergeMaxMsgs: "10",
			mergeForcedReleaseMs: "180000",
			mediaHoldMs: "3000",
			maxOutgoingFileBytes: "20971520",
			sendWechatRateLimitPerMinute: "10",
		}),
	);
	assert.equal(payload.cardTimeoutMs, 1800000);
	assert.equal(payload.mergeSilenceMs, 0, "0 is meaningful for mergeSilenceMs");
	assert.equal(payload.mergeMaxMsgs, 10);
	assert.equal(payload.mergeForcedReleaseMs, 180000);
	assert.equal(payload.mediaHoldMs, 3000);
	assert.equal(payload.maxOutgoingFileBytes, 20971520);
	assert.equal(payload.sendWechatRateLimitPerMinute, 10);
});

test("payloadOf: every editable switch is present and boolean-coerced", () => {
	const payload = payloadOf(
		baseForm({
			crossSessionNotify: true,
			notifyTaskEvents: true,
			silent: true,
			finalOnly: true,
			mergeEnabled: true,
			mergeSuffixTokens: true,
			mediaMergeEnabled: true,
			mediaAtRefEnabled: true,
			allowRemotePermissionEscalation: true,
			allowAnyFilePath: true,
			surfacePromptEnabled: true,
		}),
	);
	for (const key of [
		"crossSessionNotify",
		"notifyTaskEvents",
		"silent",
		"finalOnly",
		"mergeEnabled",
		"mergeSuffixTokens",
		"mediaMergeEnabled",
		"mediaAtRefEnabled",
		"allowRemotePermissionEscalation",
		"allowAnyFilePath",
		"surfacePromptEnabled",
	]) {
		assert.equal(payload[key], true, `${key} must be in the save payload`);
	}
});

test("payloadOf: cwd is trimmed, allowlist splits on newlines and commas", () => {
	const payload = payloadOf(
		baseForm({ cwd: "  /Users/me/app  ", allowedUsers: "alice,\n bob \n\n carol" }),
	);
	assert.equal(payload.cwd, "/Users/me/app");
	assert.deepEqual(payload.allowedUsers, ["alice", "bob", "carol"]);
	assert.equal(payloadOf(baseForm({ allowedUsers: "" })).allowedUsers instanceof Array, true);
	assert.deepEqual(payloadOf(baseForm({ allowedUsers: "" })).allowedUsers, []);
});

test("payloadOf: surface prompt body is forwarded verbatim", () => {
	const payload = payloadOf(
		baseForm({ surfacePromptEnabled: true, surfacePrompt: "你正在通过微信聊天" }),
	);
	assert.equal(payload.surfacePromptEnabled, true);
	assert.equal(payload.surfacePrompt, "你正在通过微信聊天");
});

// ---- localStorage-backed collapse state ------------------------------------

test("collapse state: without a browser storage the panel still works (reads defaults)", () => {
	// Node has no window.localStorage — never throw, never remember.
	assert.deepEqual(loadOpenGroups(), {});
	assert.equal(loadHelpOpen(), false);
	storeOpenGroups({ merge: true });
	storeHelpOpen(true);
	assert.deepEqual(loadOpenGroups(), {});
	assert.equal(loadHelpOpen(), false);
});

test("collapse state: storage keys keep the dsh-wechat names (state survives the merge)", () => {
	assert.equal(OPEN_KEY, "dsh-wechat/settings-open");
	assert.equal(HELP_OPEN_KEY, "dsh-wechat/help-open");
});

test("collapse state: round-trips through a storage-like window", () => {
	const data = new Map<string, string>();
	const fakeWindow = {
		localStorage: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value),
		},
	};
	const globals = globalThis as { window?: unknown };
	const previous = globals.window;
	globals.window = fakeWindow;
	try {
		storeOpenGroups({ merge: true, media: true });
		storeHelpOpen(true);
		assert.equal(loadHelpOpen(), true);
		assert.equal(JSON.parse(data.get(OPEN_KEY) ?? "{}").merge, true);
		assert.equal(data.get(HELP_OPEN_KEY), "true");
		writeStore("x/y", { a: 1 });
		assert.deepEqual(readStore("x/y"), { a: 1 });
	} finally {
		globals.window = previous;
	}
});

// ---- API prefix ------------------------------------------------------------

test("api: always talks to /wechat/api/* (the host route prefix is a contract)", async () => {
	const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
	const globals = globalThis as {
		fetch?: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
	};
	const previous = globals.fetch;
	globals.fetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	};
	try {
		const result = await api("/status");
		assert.equal(result.ok, true);
		assert.deepEqual(result.body, { ok: true });
		assert.equal(calls[0]?.url, "/wechat/api/status");
		assert.equal(
			(calls[0]?.init?.headers as Record<string, string> | undefined)?.["Content-Type"],
			"application/json",
		);
	} finally {
		globals.fetch = previous;
	}
});

// ---- summaries (what a collapsed group reports) ----------------------------

test("minutes/bytes: human units, invalid values report 未设置", () => {
	assert.equal(minutes(180000), "3 分钟");
	assert.equal(minutes(3000), "3 秒");
	assert.equal(minutes(0), "未设置");
	assert.equal(bytes(20971520), "20 MiB");
	assert.equal(bytes(2048), "2 KiB");
	assert.equal(bytes(""), "未设置");
});

test("allowlistSummary: blank means unrestricted", () => {
	assert.equal(allowlistSummary(""), "白名单 不限");
	assert.equal(allowlistSummary("a\nb"), "白名单 2 个");
});

test("group summaries report the live form, including the disabled cases", () => {
	const off = baseForm();
	assert.equal(summarizeMerge(off), "已关闭 · 每条消息各自一轮");
	assert.equal(summarizeDelivery(off), "静默 关 · 结论 关 · 决策推送 关 · 任务提醒 关");
	assert.equal(summarizeMedia(off), "合并 关 · 附件各自一轮 · 路径");
	assert.equal(summarizeConnection(off), "未设置目录 · 卡片 未设置 · 限流 不限/分 · 白名单 不限");
	assert.equal(summarizePrompt(off), "已关闭 · 不注入");
	assert.equal(summarizeSecurity(off), "默认收紧 · 文件上限 未设置");

	const on = baseForm({
		cwd: "/Users/me/app",
		cardTimeoutMs: "1800000",
		crossSessionNotify: true,
		notifyTaskEvents: true,
		silent: true,
		finalOnly: true,
		mergeEnabled: true,
		mergeSilenceMs: "3000",
		mergeMaxMsgs: "10",
		mergeForcedReleaseMs: "180000",
		mediaMergeEnabled: true,
		mediaHoldMs: "180000",
		mediaAtRefEnabled: true,
		surfacePromptEnabled: true,
		surfacePrompt: "你在微信里",
		allowRemotePermissionEscalation: true,
		allowAnyFilePath: true,
		maxOutgoingFileBytes: "20971520",
		sendWechatRateLimitPerMinute: "10",
	});
	assert.match(summarizeMerge(on), /已开启 · 静默 3000ms · 上限 10 条 · 强制 3 分钟/);
	assert.match(summarizeDelivery(on), /静默 开 · 结论 开 · 决策推送 开 · 任务提醒 开/);
	assert.match(summarizeMedia(on), /合并 开 · 等待 3 分钟 · @引用/);
	assert.match(summarizeConnection(on), /\/Users\/me\/app · 卡片 30 分钟 · 限流 10\/分/);
	assert.equal(summarizePrompt(on), "已开启 · 5 字");
	assert.match(summarizeSecurity(on), /已放宽：远程放宽权限、任意路径发送 · 文件上限 20 MiB/);
});

test("group summaries are empty while the form has not loaded", () => {
	assert.equal(summarizeMerge(null), "");
	assert.equal(summarizeSecurity(null), "");
});

// ---- command-row tooltip ---------------------------------------------------

test("tooltipFor: first two examples plus a count for the rest", () => {
	const entry: WechatHelpCommand = {
		id: "merge",
		command: "/merge",
		aliases: [],
		summary: "打字合并",
		usage: "/merge on|off",
		group: "pacing",
		examples: [
			{ line: "/merge on", note: "开启" },
			{ line: "/merge off", note: "关闭" },
			{ line: "/merge", note: "状态" },
		],
	};
	const text = tooltipFor(entry);
	assert.match(text, /^\/merge on {2}— {2}开启/);
	assert.match(text, /\/merge off {2}— {2}关闭/);
	assert.match(text, /共 3 条示例，展开查看全部/);
	assert.ok(!text.includes("/merge  —  状态"));
});
