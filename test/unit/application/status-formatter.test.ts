import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatStatusLine,
  statusDetailLines,
  redactSecrets,
  boundedUtf8String,
} from "../../../src/application/status-formatter.ts";
import type { BridgeStatus } from "../../../src/common/types.ts";

const status: BridgeStatus = {
  connState: "connected",
  wsReady: true,
  outboxPending: 3,
  outboxFailed: 1,
  inboundPending: 0,
  inboundFailed: 0,
  sessions: 2,
};

test("status-formatter: line contains key metrics", () => {
  const line = formatStatusLine(status);
  assert.ok(line.includes("CONNECTED"));
  assert.ok(line.includes("outbox: 3 待发 / 1 失败"));
  assert.ok(line.includes("会话: 2"));
});

test("status-formatter: quarantine renders countdown", () => {
  const q: BridgeStatus = { ...status, connState: "quarantined", quarantinedUntil: Date.now() + 5 * 60_000 };
  const line = formatStatusLine(q);
  assert.ok(line.includes("熔断"));
});

test("GH #9: status surfaces failed inbound replays (inboundPending=0 must not lie)", () => {
  const s: BridgeStatus = { ...status, inboundPending: 0, inboundFailed: 2 };
  const line = formatStatusLine(s);
  assert.ok(line.includes("补发失败: 2"), "status line shows failed replays: " + line);
  const detail = statusDetailLines(s);
  assert.ok(
    detail.some((l) => l.includes("入站补发失败: 2")),
    "detail lines show failed replays",
  );
});

test("status-formatter: detail lines are exhaustive", () => {
  const lines = statusDetailLines(status);
  assert.ok(lines.some((l) => l.includes("WS 就绪: true")));
  assert.ok(lines.some((l) => l.includes("outbox 待发: 3")));
});

test("status-formatter: redactSecrets masks listed secrets and long tokens", () => {
  const out = redactSecrets("appSecret=abc123 secret=xyz hmm abc123 ends", ["xyz", "abc123"]);
  assert.ok(!out.includes("xyz"), "listed secret masked");
  assert.ok(!out.includes("abc123"), "listed secret masked");
  const long = redactSecrets("token=abcdefghijklmnopqrstuvwxyz1234567890", []);
  assert.ok(long.includes("***"), "long token masked");
});

test("status-formatter: redactSecrets masks Bearer tokens and sk- provider keys", () => {
  const bearer = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token", []);
  assert.ok(!bearer.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "Bearer token masked");
  assert.ok(bearer.includes("Bearer ***"), "Bearer prefix preserved");

  const sk = redactSecrets("apiKey: sk-proj-1234567890abcdef12345678", []);
  assert.ok(!sk.includes("sk-proj-1234567890abcdef12345678"), "sk key masked");
  assert.ok(sk.includes("***"), "secret masked");

  const bareSk = redactSecrets("raw provider key sk-proj-1234567890abcdef12345678 in text", []);
  assert.ok(!bareSk.includes("1234567890abcdef12345678"), "bare sk key masked");
  assert.ok(bareSk.includes("sk-***"), "sk prefix marked");
});

test("status-formatter: boundedUtf8String truncates safely without broken characters", () => {
  const ascii = boundedUtf8String("hello world", 5);
  assert.equal(ascii, "hello");

  // Multi-byte Chinese characters (3 bytes each)
  const cn = boundedUtf8String("飞书桥接", 6); // 2 characters = 6 bytes
  assert.equal(cn, "飞书");

  const cnPartial = boundedUtf8String("飞书桥接", 7); // 7 bytes would cut 3rd char, safely clamped to 6
  assert.equal(cnPartial, "飞书");
});
