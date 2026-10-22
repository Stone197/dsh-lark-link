import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardKitStream } from "../../../src/outbound/cardkit-stream.ts";

interface Call {
  op: string;
  args: unknown[];
}

function fakeApi() {
  const calls: Call[] = [];
  let nextId = 1;
  const api = {
    async createCard(payload: unknown) {
      calls.push({ op: "create", args: [payload] });
      return { card_id: `card-${nextId++}` };
    },
    async deliverCard(cardId: string) {
      calls.push({ op: "deliver", args: [cardId] });
      return {};
    },
    async streamText(cardId: string, elementId: string, body: unknown) {
      calls.push({ op: "streamText", args: [cardId, elementId, body] });
      return {};
    },
    async patchSettings(cardId: string, body: unknown) {
      calls.push({ op: "settings", args: [cardId, body] });
      return {};
    },
    async updateCard(cardId: string, body: unknown) {
      calls.push({ op: "update", args: [cardId, body] });
      return {};
    },
  };
  return { calls, api };
}

function runCard(text: string, streaming = true): object {
  return {
    schema: "2.0",
    config: { streaming_mode: streaming, summary: { content: text } },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

function parseCreate(calls: Call[]): Record<string, any> {
  const create = calls.find((c) => c.op === "create")!;
  const payload = create.args[0] as { type: string; data: string };
  assert.equal(payload.type, "card_json");
  return JSON.parse(payload.data) as Record<string, any>;
}

function updateBodies(calls: Call[]): Array<Record<string, any>> {
  return calls
    .filter((c) => c.op === "update")
    .map((c) => JSON.parse((c.args[1] as { card: { data: string } }).card.data));
}

function sequences(calls: Call[]): number[] {
  return calls
    .filter((c) => c.op === "streamText" || c.op === "settings" || c.op === "update")
    .map((c) => (c.args[c.args.length - 1] as { sequence: number }).sequence);
}

test("cardkit card: first updateCard creates a streaming entity and delivers the WHOLE card", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, minPushIntervalMs: 800, now: () => 0 });
  const card = {
    schema: "2.0",
    config: { streaming_mode: true, update_multi: true, summary: { content: "思考中" } },
    body: {
      elements: [
        { tag: "markdown", content: "hi" },
        { tag: "button", text: { tag: "plain_text", content: "⏹ 终止" } },
      ],
    },
  };
  await stream.updateCard(card);
  assert.ok(stream.cardId.startsWith("card-"));
  const created = parseCreate(calls);
  assert.equal(created.schema, "2.0");
  assert.equal(created.config.streaming_mode, true);
  assert.equal(created.config.update_multi, true);
  assert.deepEqual(created.config.summary, { content: "思考中" });
  assert.equal(created.body.elements.length, 2, "whole card body preserved (no markdown wrapper)");
  assert.equal(calls.find((c) => c.op === "deliver")!.args[0], stream.cardId);
});

test("cardkit card: updates are coalesced/throttled to minPushIntervalMs and latest wins", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, minPushIntervalMs: 800, now: () => fakeNow });
  await stream.updateCard(runCard("v0")); // create at t=0
  await stream.updateCard(runCard("v1")); // t=0 → throttled
  await stream.updateCard(runCard("v2")); // t=0 → replaces pending
  assert.equal(calls.filter((c) => c.op === "update").length, 0, "within the gate → no push");

  fakeNow = 800;
  await stream.updateCard(runCard("v3")); // gate open → push latest
  const bodies = updateBodies(calls);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.config!.summary, { content: "v3" });

  await stream.finalizeCard(runCard("final", false));
  const finals = updateBodies(calls);
  assert.equal(finals.length, 2);
  assert.deepEqual(finals[1]!.config!.summary, { content: "final" });
});

test("cardkit card: identical consecutive snapshots are skipped (no-op push)", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, now: () => fakeNow });
  const card = runCard("same");
  await stream.updateCard(card); // create
  fakeNow = 1;
  await stream.updateCard(card); // identical → skipped
  assert.equal(calls.filter((c) => c.op === "update").length, 0);
  fakeNow = 2;
  await stream.updateCard(runCard("changed"));
  assert.equal(calls.filter((c) => c.op === "update").length, 1);
});

test("cardkit card: sequence stays strictly monotonic across element stream + card updates + finalize", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({
    api,
    minPushIntervalMs: 0,
    now: () => fakeNow,
  });
  // Legacy element stream creates the card first.
  await stream.patch("hello");
  fakeNow = 10;
  await stream.patch(" world");
  fakeNow = 20;
  await stream.updateCard(runCard("whole card"));
  await stream.finalizeCard(runCard("final", false));

  const seqs = sequences(calls);
  assert.ok(seqs.length >= 4, `expected multiple sequenced ops, got ${JSON.stringify(seqs)}`);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, `sequence must strictly increase: ${JSON.stringify(seqs)}`);
  }
});

test("cardkit card: finalizeCard disables streaming then PUTs the durable final card", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, now: () => 0 });
  await stream.updateCard(runCard("running"));
  const cardId = stream.cardId;
  const finalId = await stream.finalizeCard(runCard("done", false));
  assert.equal(finalId, cardId);

  const settings = calls.find((c) => c.op === "settings")!;
  const parsed = JSON.parse(
    (settings.args[1] as { settings: string }).settings,
  ) as { config: { streaming_mode: boolean } };
  assert.equal(parsed.config.streaming_mode, false);

  const finalBody = updateBodies(calls).at(-1)!;
  assert.equal(finalBody.config.streaming_mode, false);
  assert.deepEqual(finalBody.config.summary, { content: "done" });
  assert.equal(stream.disposed, true);
});

test("cardkit card: finalizeCard RE-THROWS when the final PUT fails (outbox fallback)", async () => {
  const calls: Call[] = [];
  const api = {
    async createCard(payload: unknown) {
      calls.push({ op: "create", args: [payload] });
      return { card_id: "card-f" };
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard(cardId: string, body: unknown) {
      calls.push({ op: "update", args: [cardId, body] });
      throw new Error("final PUT failed");
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.updateCard(runCard("running"));
  await assert.rejects(() => stream.finalizeCard(runCard("final", false)), /final PUT failed/);
  assert.ok(onError);
  assert.equal(stream.disposed, true);
});

test("cardkit card: finalizeCard without prior update creates the final card directly (no streaming)", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api });
  const id = await stream.finalizeCard(runCard("only final", false));
  assert.ok(id.startsWith("card-"));
  const created = parseCreate(calls);
  assert.notEqual(created.config.streaming_mode, true);
  assert.equal(created.config.summary.content, "only final");
  assert.equal(calls.find((c) => c.op === "deliver")!.args[0], id);
});

test("cardkit card: finalizeCard create failure throws and disposes", async () => {
  const api = {
    async createCard() {
      throw new Error("create down");
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  const stream = createCardKitStream({ api });
  await assert.rejects(() => stream.finalizeCard(runCard("x", false)), /create down/);
  assert.equal(stream.disposed, true);
});

test("cardkit card: updateCard create failure disposes (non-fatal) and surfaces onError", async () => {
  const api = {
    async createCard() {
      throw new Error("card api down");
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.updateCard(runCard("x"));
  assert.ok(onError);
  assert.equal(stream.disposed, true);
  await stream.updateCard(runCard("y")); // no-op after dispose, no throw
});

test("cardkit card: finalizeCard is idempotent after a previous finalize", async () => {
  const { api } = fakeApi();
  const stream = createCardKitStream({ api });
  const id = await stream.finalizeCard(runCard("final", false));
  const again = await stream.finalizeCard(runCard("final", false));
  assert.equal(again, id);
});
