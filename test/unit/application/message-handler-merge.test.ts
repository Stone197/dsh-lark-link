import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, mergeInboundBatch } from "../../../src/application/message-handler.ts";
import { createBridgeContext } from "../../../src/application/bridge-context.ts";
import { createStatusStore } from "../../../src/common/connection-status.ts";
import { createCapturingLogger } from "../../../src/common/logger.ts";
import { DEFAULT_CONFIG, type FeishuConfig } from "../../../src/common/config.ts";
import type { FeishuInboundMessage, Route } from "../../../src/common/types.ts";
import type { AttachmentInput } from "../../../src/sessions/dsh-session-backend.ts";
import type { TimerApi } from "../../../src/outbound/pending-queue.ts";

/** Deterministic timer harness — tests advance the merge window by hand. */
function manualTimers() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, { at: number; fn: () => void }>();
	const timers: TimerApi = {
		setTimeout(fn, ms) {
			const id = nextId++;
			jobs.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(handle) {
			jobs.delete(handle as number);
		},
	};
	return {
		timers,
		advance(ms: number) {
			now += ms;
			const due = [...jobs.entries()]
				.filter(([, job]) => job.at <= now)
				.sort((a, b) => a[1].at - b[1].at);
			for (const [id, job] of due) {
				if (!jobs.has(id)) continue;
				jobs.delete(id);
				job.fn();
			}
		},
		pending: () => jobs.size,
	};
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function textMsg(
	text: string,
	messageId: string,
	chatId = "oc_chat",
): FeishuInboundMessage {
	return {
		messageId,
		chatId,
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_u",
		msgType: "text",
		content: text,
		text,
		mentions: text.includes("@bot") ? ["bot"] : [],
		timestamp: Date.now(),
	};
}

function imageMsg(messageId: string, chatId = "oc_chat"): FeishuInboundMessage {
	return {
		messageId,
		chatId,
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_u",
		msgType: "image",
		content: JSON.stringify({ image_key: "img_1" }),
		text: "",
		mentions: [],
		timestamp: Date.now(),
	};
}

interface HarnessOptions {
	enabled?: boolean;
	silenceMs?: number;
	route?: (msg: FeishuInboundMessage) => "agent" | "bridge" | "dsh";
	handleFails?: boolean;
}

function harness(opts: HarnessOptions = {}) {
	const clock = manualTimers();
	const logger = createCapturingLogger("test-merge");
	const routes: Route[] = [];
	const accepts: Array<{
		messageId: string;
		sessionKey: string;
		chatId: string;
		chatType: string;
		senderOpenId: string;
		text: string;
	}> = [];
	const dispatches: Array<{
		msg: FeishuInboundMessage;
		attachments: AttachmentInput[];
	}> = [];

	const cfg: FeishuConfig = {
		...DEFAULT_CONFIG,
		reactions: { ...DEFAULT_CONFIG.reactions, enabled: false },
		inboundMerge: {
			enabled: opts.enabled ?? true,
			silenceMs: opts.silenceMs ?? 1000,
		},
	};

	const ctx = createBridgeContext({
		logger,
		cfg: () => cfg,
		status: createStatusStore(undefined),
		router: {
			upsert: (route: Route) => {
				routes.push(route);
			},
			get: () => undefined,
			all: () => [],
			touch: () => {},
			remove: () => {},
			prune: () => {},
			persist: () => {},
			ds: () => undefined,
		} as never,
	});
	ctx.setConversations({
		keyFor: (msg: FeishuInboundMessage) => `dm:${msg.chatId}`,
		async handleMessage(msg: FeishuInboundMessage, attachments?: AttachmentInput[]) {
			if (opts.handleFails) throw new Error("conversation exploded");
			dispatches.push({ msg, attachments: attachments ?? [] });
		},
	} as never);

	const seen = new Set<string>();
	const handler = createMessageHandler({
		ctx,
		commands: {
			route: async (msg: FeishuInboundMessage) =>
				opts.route ? opts.route(msg) : "agent",
		} as never,
		groupTrigger: { shouldTrigger: () => true },
		dedupe: {
			add(messageId: string) {
				if (seen.has(messageId)) return false;
				seen.add(messageId);
				return true;
			},
		},
		allowlist: () => [],
		wal: {
			accept: (record: (typeof accepts)[number]) => {
				accepts.push(record);
			},
		} as never,
		mergeTimers: clock.timers,
	});

	return { handler, clock, logger, routes, accepts, dispatches, cfg };
}

test("inbound merge: two consecutive text messages become ONE turn after the quiet window", async () => {
	const { handler, clock, dispatches, accepts, routes } = harness();
	assert.equal(await handler.handleInbound(textMsg("第一条", "m1")), "processed");
	assert.equal(await handler.handleInbound(textMsg("第二条", "m2")), "processed");
	assert.equal(dispatches.length, 0, "nothing dispatched before the quiet window elapses");
	assert.equal(accepts.length, 0, "WAL accept is deferred to the flush");

	clock.advance(999);
	await tick();
	assert.equal(dispatches.length, 0, "still inside the window");

	clock.advance(1);
	await tick();
	assert.equal(dispatches.length, 1, "merged into exactly one agent turn");
	const [dispatch] = dispatches;
	assert.equal(dispatch!.msg.text, "第一条\n\n第二条", "texts joined in arrival order");
	assert.equal(dispatch!.msg.messageId, "m2", "last message is the base (DONE-reaction target)");

	assert.equal(accepts.length, 1, "exactly ONE WAL record for the merged turn");
	assert.equal(accepts[0]!.messageId, "m2");
	assert.equal(accepts[0]!.text, "第一条\n\n第二条");
	assert.equal(accepts[0]!.sessionKey, "dm:oc_chat");
	assert.equal(accepts[0]!.chatId, "oc_chat");

	assert.equal(routes.length, 1, "route upserted once at flush");
	assert.equal(routes[0]!.lastMessageId, "m2");
	assert.equal(routes[0]!.sessionKey, "dm:oc_chat");
});

test("inbound merge: a new message restarts the quiet window", async () => {
	const { handler, clock, dispatches } = harness();
	await handler.handleInbound(textMsg("a", "m1"));
	clock.advance(700);
	await handler.handleInbound(textMsg("b", "m2"));
	clock.advance(700); // 700ms after the SECOND message
	await tick();
	assert.equal(dispatches.length, 0, "window restarted at the latest message");
	clock.advance(300);
	await tick();
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0]!.msg.text, "a\n\nb");
});

test("inbound merge: command-shaped messages bypass the queue (immediate dispatch)", async () => {
	const { handler, clock, dispatches } = harness();
	await handler.handleInbound(textMsg("/mode minimal", "cmd1"));
	assert.equal(dispatches.length, 1, "command dispatched immediately");
	assert.equal(dispatches[0]!.msg.text, "/mode minimal");
	clock.advance(5_000);
	await tick();
	assert.equal(dispatches.length, 1, "no extra flush");
});

test("inbound merge: bridge/dsh-routed commands never enter the queue", async () => {
	const { handler, clock, dispatches } = harness({
		route: (msg) => (msg.text?.startsWith("/") ? "bridge" : "agent"),
	});
	await handler.handleInbound(textMsg("/help", "cmd2"));
	assert.equal(dispatches.length, 0, "handled by the command router, not the agent");
	await handler.handleInbound(textMsg("hello", "m1"));
	clock.advance(1000);
	await tick();
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0]!.msg.text, "hello");
});

test("inbound merge: enabled=false keeps the legacy direct path (no delay)", async () => {
	const { handler, clock, dispatches } = harness({ enabled: false });
	await handler.handleInbound(textMsg("one", "m1"));
	await handler.handleInbound(textMsg("two", "m2"));
	assert.equal(dispatches.length, 2, "each message is its own turn");
	assert.deepEqual(
		dispatches.map((d) => d.msg.messageId),
		["m1", "m2"],
	);
	clock.advance(5_000);
	await tick();
	assert.equal(dispatches.length, 2, "queue never armed");
});

test("inbound merge: media messages take the direct path (attachments cannot merge)", async () => {
	const { handler, clock, dispatches, accepts } = harness();
	await handler.handleInbound(imageMsg("img-m1"));
	assert.equal(dispatches.length, 1, "image dispatched immediately");
	assert.equal(dispatches[0]!.msg.msgType, "image");
	assert.equal(accepts.length, 0, "media is not journaled");
	clock.advance(5_000);
	await tick();
	assert.equal(dispatches.length, 1);
});

test("inbound merge: compensated replays bypass the queue and are NOT re-journaled", async () => {
	const { handler, clock, dispatches, accepts } = harness();
	await handler.handleCompensated(textMsg("compensated", "wc1"));
	assert.equal(dispatches.length, 1, "replay dispatched immediately");
	assert.equal(accepts.length, 0, "replay must not re-accept in the WAL");
	clock.advance(5_000);
	await tick();
	assert.equal(dispatches.length, 1);
});

test("inbound merge: pauseMerge blocks flushing, resumeMerge arms a fresh window", async () => {
	const { handler, clock, dispatches } = harness();
	handler.pauseMerge?.("dm:oc_chat");
	await handler.handleInbound(textMsg("while running", "m1"));
	clock.advance(10_000);
	await tick();
	assert.equal(dispatches.length, 0, "a running turn blocks the merge flush");

	handler.resumeMerge?.("dm:oc_chat");
	clock.advance(1000);
	await tick();
	assert.equal(dispatches.length, 1, "queued message flushed after the turn ended");
});

test("inbound merge: flush dispatch failure is logged, never thrown (no unhandled rejection)", async () => {
	const { handler, clock, logger, dispatches } = harness({ handleFails: true });
	await handler.handleInbound(textMsg("doomed", "m1"));
	clock.advance(1000);
	await tick();
	await tick();
	assert.equal(dispatches.length, 0);
	assert.ok(
		logger.lines.some(
			(line) =>
				line.includes("inbound merge dispatch failed") ||
				line.includes("conversation handling failed"),
		),
		`flush failure must be logged, got: ${JSON.stringify(logger.lines)}`,
	);
});

test("inbound merge: dispose cancels pending windows (plugin shutdown)", async () => {
	const { handler, clock, dispatches } = harness();
	await handler.handleInbound(textMsg("pending", "m1"));
	assert.equal(clock.pending(), 1);
	handler.dispose?.();
	clock.advance(5_000);
	await tick();
	assert.equal(dispatches.length, 0, "nothing flushes after dispose");
});

test("inbound merge: hot-reloading silenceMs rebuilds the queue with the new window", async () => {
	const { handler, clock, dispatches, cfg } = harness({ silenceMs: 1000 });
	await handler.handleInbound(textMsg("a", "m1"));
	assert.equal(clock.pending(), 1);
	// /lark-config inboundMerge.silenceMs=100 (live cfg getter is re-read per push)
	cfg.inboundMerge.silenceMs = 100;
	await handler.handleInbound(textMsg("b", "m2"));
	// Rebuild drops the half-open 1000ms window (documented, rare) and arms 100ms.
	clock.advance(100);
	await tick();
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0]!.msg.messageId, "m2");
});

test("mergeInboundBatch: pure merge keeps the last message identity and unions mentions", () => {
	const first = textMsg("第一条 @bot", "m1");
	const second = textMsg("第二条", "m2");
	second.chatId = "oc_chat";
	second.mentions = ["bot", "other"];
	const merged = mergeInboundBatch([
		{ msg: first, sessionKey: "dm:oc_chat", attachments: [] },
		{ msg: second, sessionKey: "dm:oc_chat", attachments: [] },
	]);
	assert.equal(merged.msg.messageId, "m2");
	assert.equal(merged.msg.chatId, "oc_chat");
	assert.equal(merged.msg.msgType, "text");
	assert.equal(merged.msg.content, "第一条 @bot\n\n第二条");
	assert.deepEqual(merged.msg.mentions, ["bot", "other"]);
	assert.deepEqual(merged.attachments, []);
});

test("mergeInboundBatch: attachments of every queued message are concatenated", () => {
	const attachmentsA: AttachmentInput[] = [
		{ path: "/tmp/a.png", kind: "image", name: "a.png" },
	];
	const attachmentsB: AttachmentInput[] = [
		{ path: "/tmp/b.pdf", kind: "file", name: "b.pdf" },
	];
	const merged = mergeInboundBatch([
		{ msg: textMsg("a", "m1"), sessionKey: "dm:x", attachments: attachmentsA },
		{ msg: textMsg("b", "m2"), sessionKey: "dm:x", attachments: attachmentsB },
	]);
	assert.deepEqual(
		merged.attachments.map((a) => a.name),
		["a.png", "b.pdf"],
	);
});
