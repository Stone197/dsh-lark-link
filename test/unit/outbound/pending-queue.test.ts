import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PendingQueue,
  type TimerApi,
} from "../../../src/outbound/pending-queue.ts";

/** Deterministic timer harness — no real waiting in tests. */
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

interface Msg {
  id: string;
  command?: boolean;
}

function makeQueue(opts: { delayedFlush?: boolean } = {}) {
  const clock = manualTimers();
  const flushes: Array<{ scope: string; batch: Msg[] }> = [];
  const errors: unknown[] = [];
  const queue = new PendingQueue<Msg>({
    delayMs: 600,
    timers: clock.timers,
    isCommand: (m) => m.command === true,
    onFlush: (scope, batch) => {
      if (opts.delayedFlush) throw new Error("flush handler failed");
      flushes.push({ scope, batch });
    },
    onError: (err) => errors.push(err),
  });
  return { queue, clock, flushes, errors };
}

test("pending-queue: messages inside the quiet window merge into ONE batch", () => {
  const { queue, clock, flushes } = makeQueue();
  assert.equal(queue.push("dm:a", { id: "1" }), 1);
  clock.advance(300);
  assert.equal(queue.push("dm:a", { id: "2" }), 2);
  clock.advance(300); // window restarted at the last push
  assert.equal(flushes.length, 0, "still inside the quiet window");
  clock.advance(300);
  assert.equal(flushes.length, 1);
  assert.deepEqual(flushes[0]!.batch.map((m) => m.id), ["1", "2"]);
});

test("pending-queue: separate scopes debounce independently", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.push("dm:a", { id: "a1" });
  queue.push("dm:b", { id: "b1" });
  clock.advance(600);
  assert.equal(flushes.length, 2);
  const scopes = flushes.map((f) => f.scope).sort();
  assert.deepEqual(scopes, ["dm:a", "dm:b"]);
});

test("pending-queue: block() stops flushing while a turn runs, unblock() re-arms", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.block("dm:a");
  queue.push("dm:a", { id: "1" });
  clock.advance(5_000);
  assert.equal(flushes.length, 0, "blocked scope never flushes");
  assert.equal(queue.size("dm:a"), 1);
  assert.equal(queue.isBlocked("dm:a"), true);

  queue.push("dm:a", { id: "2" }); // accumulates while running
  queue.unblock("dm:a");
  assert.equal(queue.isBlocked("dm:a"), false);
  clock.advance(600);
  assert.equal(flushes.length, 1);
  assert.deepEqual(flushes[0]!.batch.map((m) => m.id), ["1", "2"]);
});

test("pending-queue: unblock with nothing queued arms nothing", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.block("dm:a");
  queue.unblock("dm:a");
  clock.advance(5_000);
  assert.equal(flushes.length, 0);
  assert.equal(clock.pending(), 0);
});

test("pending-queue: command messages bypass the queue (singleton immediate batch)", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.push("dm:a", { id: "text-1" });
  queue.push("dm:a", { id: "cmd", command: true });
  assert.equal(flushes.length, 1, "command flushed immediately");
  assert.deepEqual(flushes[0]!.batch.map((m) => m.id), ["cmd"]);
  assert.equal(queue.size("dm:a"), 1, "pending text batch untouched");
  clock.advance(600);
  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[1]!.batch.map((m) => m.id), ["text-1"]);
});

test("pending-queue: cancel() drops the batch without flushing", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.push("dm:a", { id: "1" });
  queue.push("dm:a", { id: "2" });
  const dropped = queue.cancel("dm:a");
  assert.deepEqual(dropped.map((m) => m.id), ["1", "2"]);
  clock.advance(5_000);
  assert.equal(flushes.length, 0);
});

test("pending-queue: cancelAll() clears every scope and block state", () => {
  const { queue, clock, flushes } = makeQueue();
  queue.block("dm:a");
  queue.push("dm:a", { id: "1" });
  queue.push("dm:b", { id: "2" });
  queue.cancelAll();
  assert.equal(queue.size("dm:a"), 0);
  assert.equal(queue.isBlocked("dm:a"), false);
  clock.advance(5_000);
  assert.equal(flushes.length, 0);
});

test("pending-queue: flush handler errors are contained and reported", () => {
  const { queue, clock, errors } = makeQueue({ delayedFlush: true });
  queue.push("dm:a", { id: "1" });
  clock.advance(600);
  assert.equal(errors.length, 1);
  assert.equal(queue.size("dm:a"), 0, "failed batch is not re-queued (best-effort)");
});
