// ReplayRunner (GH #14): the shared inbound-replay routine used by BOTH the
// boot-time automatic replay and the manual `/lark replay` trigger. Verified:
// salvage-first ordering, compensated re-dispatch fallback, skip accounting,
// prune invocation, and that pending/failed counts reflect the post-run WAL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createInboundWal } from "../../../src/inbound/inbound-wal.ts";
import {
  createReplayRunner,
  type ReplayRunnerDeps,
} from "../../../src/inbound/replay-runner.ts";
import type { InboundWalRecord } from "../../../src/inbound/inbound-wal.ts";

function tmpdir(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dsh-runner-"));
}

function harness(opts: {
  salvageable?: (rec: InboundWalRecord) => boolean;
  redispatchFails?: (rec: InboundWalRecord) => boolean;
} = {}) {
  const wal = createInboundWal({ dir: join(tmpdir(), "wal") });
  const redispatched: string[] = [];
  const salvaged: string[] = [];
  const deps: ReplayRunnerDeps = {
    wal,
    salvage: async (rec) => {
      if (opts.salvageable?.(rec)) {
        wal.delivered(rec.messageId);
        salvaged.push(rec.messageId);
        return true;
      }
      return false;
    },
    activeSessionId: () => "session-1",
    redispatch: async (rec) => {
      if (opts.redispatchFails?.(rec)) throw new Error("dispatch down");
      redispatched.push(rec.messageId);
    },
    prune: () => wal.prune(),
  };
  return { wal, deps, redispatched, salvaged };
}

test("replay runner: salvage wins — answered records are not re-dispatched", async () => {
  const h = harness({
    salvageable: (rec) => rec.messageId === "m_salvage",
  });
  h.wal.accept({
    messageId: "m_salvage",
    sessionKey: "dm:o1",
    chatId: "o1",
    chatType: "p2p",
    senderOpenId: "ou1",
    text: "answer me",
  });
  h.wal.accept({
    messageId: "m_rerun",
    sessionKey: "dm:o2",
    chatId: "o2",
    chatType: "p2p",
    senderOpenId: "ou2",
    text: "run me",
  });
  const r = await createReplayRunner(h.deps).run();
  assert.deepEqual(h.salvaged, ["m_salvage"]);
  assert.deepEqual(h.redispatched, ["m_rerun"]);
  assert.equal(r.salvaged, 1);
  assert.equal(r.replayed, 1);
  // m_salvage was delivered (excluded); m_rerun was re-dispatched but the
  // fake pipeline delivered nothing, so it stays pending (attempt=1).
  assert.equal(r.pending, 1);
  assert.equal(
    h.wal.pendingReplays().some((x) => x.messageId === "m_rerun"),
    true,
  );
});

test("replay runner: failed re-dispatch counts as skipped (never crashes the run)", async () => {
  const h = harness({ redispatchFails: () => true });
  h.wal.accept({
    messageId: "m_boom",
    sessionKey: "dm:o3",
    chatId: "o3",
    chatType: "p2p",
    senderOpenId: "ou3",
    text: "explode",
  });
  const r = await createReplayRunner(h.deps).run();
  assert.equal(r.replayed, 0);
  assert.equal(r.skipped, 1);
});

test("replay runner: prune runs first; over-cap records are skipped (markReplay false)", async () => {
  let pruned = false;
  const h = harness();
  h.deps.prune = () => {
    pruned = true;
    h.wal.prune();
  };
  h.wal.accept({
    messageId: "m_cap",
    sessionKey: "dm:o4",
    chatId: "o4",
    chatType: "p2p",
    senderOpenId: "ou4",
    text: "capped",
  });
  assert.equal(h.wal.markReplay("m_cap"), true); // attempt 1
  assert.equal(h.wal.markReplay("m_cap"), true); // attempt 2 (cap → failed)
  assert.equal(h.wal.markReplay("m_cap"), false);
  // The record is now failed — the runner must not see it as pending at all.
  const r = await createReplayRunner(h.deps).run();
  assert.equal(pruned, true, "prune invoked before the sweep");
  assert.deepEqual(h.redispatched, []);
  assert.equal(r.replayed, 0);
  assert.equal(r.failed, 1, "exhausted record surfaces as failed");
});
