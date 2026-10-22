import { test } from "node:test";
import assert from "node:assert/strict";
import { createStopCallbackAuth } from "../../../src/outbound/run-callback.ts";

function auth(now = 1_000) {
  let current = now;
  const instance = createStopCallbackAuth({
    secret: "app-secret",
    ttlMs: 60_000,
    now: () => current,
    createNonce: (() => {
      let n = 0;
      return () => `nonce-${++n}`;
    })(),
  });
  return {
    instance,
    advance(ms: number) {
      current += ms;
    },
  };
}

test("run-callback: signed token verifies for the matching chat/session", () => {
  const { instance } = auth();
  const token = instance.sign({ sessionKey: "dm:ou_x", chatId: "oc_x" });
  const result = instance.verify(token, { sessionKey: "dm:ou_x", chatId: "oc_x" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sessionKey, "dm:ou_x");
    assert.equal(result.claims.chatId, "oc_x");
    assert.equal(result.claims.action, "stop");
  }
});

test("run-callback: token for another chat/session is rejected (context-mismatch)", () => {
  const { instance } = auth();
  const token = instance.sign({ sessionKey: "dm:ou_x", chatId: "oc_x" });
  assert.deepEqual(instance.verify(token, { chatId: "oc_other" }), {
    ok: false,
    reason: "context-mismatch",
  });
  assert.deepEqual(
    instance.verify(token, { sessionKey: "dm:ou_other", chatId: "oc_x" }),
    { ok: false, reason: "context-mismatch" },
  );
});

test("run-callback: tampered payload signature is rejected", () => {
  const { instance } = auth();
  const token = instance.sign({ sessionKey: "dm:ou_x", chatId: "oc_x" });
  const parts = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      sessionKey: "dm:ou_x",
      chatId: "oc_x",
      action: "stop",
      exp: Date.now() + 1_000_000,
      nonce: "forged",
    }),
    "utf8",
  ).toString("base64url");
  const tampered = `${parts[0]}.${parts[1]}.${forged}.${parts[3]}`;
  assert.deepEqual(instance.verify(tampered, { chatId: "oc_x" }), {
    ok: false,
    reason: "bad-signature",
  });
});

test("run-callback: expired token is rejected", () => {
  const { instance, advance } = auth();
  const token = instance.sign({ sessionKey: "dm:ou_x", chatId: "oc_x" });
  advance(60_001);
  assert.deepEqual(instance.verify(token, { chatId: "oc_x" }), {
    ok: false,
    reason: "expired",
  });
});

test("run-callback: replay of the same token is rejected (nonce consumed once)", () => {
  const { instance } = auth();
  const token = instance.sign({ sessionKey: "dm:ou_x", chatId: "oc_x" });
  assert.equal(instance.verify(token, { chatId: "oc_x" }).ok, true);
  assert.deepEqual(instance.verify(token, { chatId: "oc_x" }), {
    ok: false,
    reason: "nonce-replay",
  });
  assert.equal(instance.nonceCount(), 1);
});

test("run-callback: malformed tokens are rejected without throwing", () => {
  const { instance } = auth();
  for (const token of ["", "nope", "runcb.v1.only-two-parts", "runcb.v1.%%%.sig"]) {
    const result = instance.verify(token, { chatId: "oc_x" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed");
  }
});
