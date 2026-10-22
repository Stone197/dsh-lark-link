import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEventForwarder,
  type EventForwarder,
  type StreamTarget,
} from "../../../src/outbound/event-forwarder.ts";
import { createOutbox, type Outbox, type OutboxSender } from "../../../src/outbound/outbox.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import type { Route, RouteRef } from "../../../src/common/types.ts";
import type { CardKitStreamHandle } from "../../../src/outbound/cardkit-stream.ts";

const route: Route = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p", updatedAt: 0 };
const routeRef: RouteRef = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p" };

interface CardShape {
  config: { streaming_mode?: boolean; summary?: { content?: string } };
  body: { elements: Array<{ tag: string; content?: string; header?: { title?: { content?: string } } }> };
}

function makeRunHandle(opts: { finalizeThrows?: boolean } = {}) {
  const updates: CardShape[] = [];
  const finals: CardShape[] = [];
  let disposed = false;
  const handle: CardKitStreamHandle = {
    cardId: "card-run",
    get disposed() {
      return disposed;
    },
    async patch() {},
    async finalize() {
      return "card-run";
    },
    async updateCard(card: object) {
      updates.push(card as CardShape);
    },
    async finalizeCard(card: object) {
      finals.push(card as CardShape);
      if (opts.finalizeThrows) throw new Error("final card PUT failed");
      disposed = true;
      return "card-run";
    },
  };
  return { handle, updates, finals };
}

function setup(opts: {
  runCardEnabled?: boolean;
  streamingEnabled?: boolean;
  finalizeThrows?: boolean;
  createFails?: boolean;
  stopToken?: string;
} = {}) {
  const sent: unknown[] = [];
  const sender: OutboxSender = {
    async deliver(_env, payload) {
      sent.push(payload);
      return { ok: true };
    },
  };
  const outbox: Outbox = createOutbox({
    dir: tempDir("fw-run-"),
    sender,
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();

  const run = makeRunHandle({ finalizeThrows: opts.finalizeThrows });
  const legacyPatches: string[] = [];
  const legacyStream: CardKitStreamHandle = {
    cardId: "card-legacy",
    disposed: false,
    async patch(text: string) {
      legacyPatches.push(text);
    },
    async finalize() {
      return "card-legacy";
    },
    async updateCard() {},
    async finalizeCard() {
      throw new Error("not the run handle");
    },
  };
  let ensureRunCalls = 0;
  let doneCount = 0;
  const target: StreamTarget = {
    route: routeRef,
    ensureStream: () => legacyStream,
    ensureRunStream: () => {
      ensureRunCalls++;
      if (opts.createFails) {
        return { ...run.handle, disposed: true } as CardKitStreamHandle;
      }
      return run.handle;
    },
    async fallbackText(text) {
      await outbox.enqueue({
        dedupeKey: `fb:${Date.now()}`,
        laneKey: "dm:ou_x",
        route: routeRef,
        kind: "final",
        payload: { kind: "text", text },
      });
    },
    async markDone() {
      doneCount++;
    },
  };

  const fw: EventForwarder = createEventForwarder({
    outbox,
    routeFor: (key) => (key === "dm:ou_x" ? route : undefined),
    streamFor: () => target,
    cfg: () => ({
      streamingEnabled: opts.streamingEnabled ?? true,
      runCardEnabled: opts.runCardEnabled ?? true,
    }),
    stopCallbackToken: opts.stopToken ? () => opts.stopToken : undefined,
  });

  return {
    fw,
    outbox,
    sent,
    run,
    legacyPatches,
    doneCount: () => doneCount,
    ensureRunCalls: () => ensureRunCalls,
  };
}

function panelText(card: CardShape): string {
  return JSON.stringify(card);
}

test("forwarder run card: turn/start creates the card with an initial snapshot", async () => {
  const { fw, run, ensureRunCalls } = setup();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  assert.equal(ensureRunCalls(), 1);
  assert.equal(run.updates.length, 1, "initial card pushed on turn/start");
  assert.equal(run.updates[0]!.config.streaming_mode, true);
  assert.ok(panelText(run.updates[0]!).includes("正在思考"));
});

test("forwarder run card: text + reasoning + tools fold into one live card", async () => {
  const { fw, run, sent } = setup();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "reasoning/delta", text: "分析需求" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "我来" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "实现" });
  await fw.onSessionEvent("dm:ou_x", {
    type: "assistant/message",
    text: "我来实现",
  });
  await fw.onSessionEvent("dm:ou_x", {
    type: "tool/call",
    callId: "c1",
    name: "bash",
    arguments: { command: "pnpm test" },
  });
  await fw.onSessionEvent("dm:ou_x", {
    type: "tool/result",
    callId: "c1",
    output: "all green",
  });

  const latest = run.updates.at(-1)!;
  const json = panelText(latest);
  assert.ok(json.includes("思考完成，点击查看"), "settled reasoning collapses");
  assert.ok(json.includes("我来实现"), "assistant text rendered");
  assert.ok(json.includes("运行命令"), "friendly tool title");
  assert.ok(json.includes("all green"), "tool output rendered");
  assert.equal(sent.length, 0, "nothing enqueued as a plain message yet");
});

test("forwarder run card: turn/end finalizes the card and skips duplicate text delivery", async () => {
  const { fw, run, sent, doneCount, outbox } = setup();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "done" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "done" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(run.finals.length, 1, "finalizeCard called once");
  const final = run.finals[0]!;
  assert.equal(final.config.streaming_mode, false);
  assert.equal(final.config.summary?.content, "已完成");
  assert.ok(panelText(final).includes("done"));
  assert.equal(sent.length, 0, "the card IS the delivery — no duplicate text message");
  assert.equal(outbox.pendingCount(), 0);
  assert.equal(doneCount(), 1, "DONE reaction still issued");
});

test("forwarder run card: finalize failure falls back to the durable outbox (no content loss)", async () => {
  const { fw, sent, doneCount } = setup({ finalizeThrows: true });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "precious" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "precious" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter(
    (p): p is { kind: string; text: string } =>
      (p as { kind?: string }).kind === "text" && (p as { text?: string }).text === "precious",
  );
  assert.equal(texts.length, 1, "card failure fell back to a durable text delivery");
  assert.equal(doneCount(), 1, "DONE still issued after fallback");
});

test("forwarder run card: aborted turn finalizes an interrupted card", async () => {
  const { fw, run } = setup();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "half" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "aborted" });
  const final = run.finals[0]!;
  assert.equal(final.config.summary?.content, "已中断");
  assert.ok(panelText(final).includes("已被中断"));
});

test("forwarder run card: stop button carries the signed callback token when configured", async () => {
  const { fw, run } = setup({ stopToken: "runcb.v1.sig" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  const json = panelText(run.updates[0]!);
  assert.ok(json.includes("runcb.v1.sig"), "signed token embedded in the stop button");
});

test("forwarder run card: disabled run mode keeps the legacy per-message delivery", async () => {
  const { fw, sent, ensureRunCalls, legacyPatches } = setup({
    runCardEnabled: false,
    streamingEnabled: false,
  });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "hi" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hi" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ensureRunCalls(), 0, "run card never requested");
  assert.deepEqual(legacyPatches, [], "no element stream when streaming is off");
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(texts.length, 1, "legacy per-message delivery preserved");
});

test("forwarder run card: card-creation failure falls back to the legacy outbox path", async () => {
  const { fw, sent } = setup({ createFails: true, streamingEnabled: false });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "fallback text" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "fallback text" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter(
    (p) => (p as { kind: string }).kind === "text" && (p as { text: string }).text === "fallback text",
  );
  assert.equal(texts.length, 1, "content survives when CardKit is unavailable");
});

test("forwarder run card: finalizeSession settles a still-running card durably", async () => {
  const { fw, run, sent } = setup();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "pending" });
  await fw.finalizeSession("dm:ou_x");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(run.finals.length, 1);
  assert.equal(run.finals[0]!.config.streaming_mode, false);
  assert.equal(sent.length, 0, "card finalize counts as delivery");
});
