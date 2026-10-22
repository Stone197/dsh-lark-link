import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRunView,
  finalizeRunView,
  markRunInterrupted,
  reduceRunView,
  runViewHasContent,
  runViewText,
  runViewToolCount,
  type RunViewState,
} from "../../../src/presentation/run-state.ts";

/** Controllable clock so terminal timestamps are deterministic. */
function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function fold(
  events: Parameters<typeof reduceRunView>[1][],
  c = clock(),
): RunViewState {
  let state = createRunView(c.now);
  for (const event of events) state = reduceRunView(state, event, c.now);
  return state;
}

test("run-state: text deltas accumulate into ONE streaming block, footer streaming", () => {
  const state = fold([
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
  ]);
  assert.equal(state.blocks.length, 1);
  const block = state.blocks[0]!;
  assert.equal(block.kind, "text");
  assert.equal(block.kind === "text" ? block.content : "", "Hello");
  assert.equal(block.kind === "text" ? block.streaming : false, true);
  assert.equal(state.footer, "streaming");
  assert.equal(state.reasoning.active, false);
});

test("run-state: reasoning deltas go to the reasoning panel, not the text blocks", () => {
  const state = fold([
    { type: "reasoning-delta", text: "think " },
    { type: "reasoning-delta", text: "harder" },
  ]);
  assert.deepEqual(state.reasoning, { content: "think harder", active: true });
  assert.equal(state.blocks.length, 0);
  assert.equal(state.footer, "thinking");
});

test("run-state: assistant/message settles the durable text and reasoning", () => {
  const state = fold([
    { type: "text-delta", text: "streamed" },
    { type: "message", text: "streamed final", reasoning: "settled reasoning" },
  ]);
  assert.equal(state.blocks.length, 1);
  const block = state.blocks[0]!;
  assert.equal(block.kind === "text" ? block.content : "", "streamed final");
  assert.equal(block.kind === "text" ? block.streaming : true, false);
  assert.deepEqual(state.reasoning, { content: "settled reasoning", active: false });
});

test("run-state: empty assistant/message adds no text block (reasoning-only turn)", () => {
  const state = fold([{ type: "message", text: "" }]);
  assert.equal(state.blocks.length, 0);
});

test("run-state: tool/call opens a running tool panel (footer tool_running)", () => {
  const state = fold([
    { type: "text-delta", text: "looking" },
    {
      type: "tool-call",
      callId: "call-1",
      name: "bash",
      arguments: { command: "ls" },
    },
  ]);
  assert.equal(state.blocks.length, 2);
  const tool = state.blocks[1]!;
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") {
    assert.equal(tool.tool.name, "bash");
    assert.equal(tool.tool.id, "call-1");
    assert.equal(tool.tool.status, "running");
    assert.deepEqual(tool.tool.input, { command: "ls" });
  }
  // opening a tool closes the streaming text block
  const text = state.blocks[0]!;
  assert.equal(text.kind === "text" ? text.streaming : true, false);
  assert.equal(state.footer, "tool_running");
});

test("run-state: tool/result correlates by callId and records output", () => {
  const state = fold([
    { type: "tool-call", callId: "c1", name: "read", arguments: { file_path: "/a" } },
    { type: "tool-call", callId: "c2", name: "grep", arguments: { pattern: "x" } },
    { type: "tool-result", callId: "c1", output: "file body", isError: false },
  ]);
  const tools = state.blocks.filter((b) => b.kind === "tool");
  const first = tools[0]!;
  const second = tools[1]!;
  assert.equal(first.kind === "tool" ? first.tool.status : "", "done");
  assert.equal(first.kind === "tool" ? first.tool.output : "", "file body");
  assert.equal(second.kind === "tool" ? second.tool.status : "", "running");
  // one tool still running → footer stays tool_running
  assert.equal(state.footer, "tool_running");
});

test("run-state: tool/result error marks the panel error and keeps the message", () => {
  const state = fold([
    { type: "tool-call", callId: "c1", name: "bash", arguments: {} },
    { type: "tool-result", callId: "c1", output: "boom: exit 1", isError: true },
  ]);
  const tool = state.blocks[0]!;
  assert.equal(tool.kind === "tool" ? tool.tool.status : "", "error");
  assert.equal(tool.kind === "tool" ? tool.tool.errorText : "", "boom: exit 1");
  assert.equal(state.footer, "tool_running", "settled tools don't fake a streaming footer");
});

test("run-state: tool/result falls back to name matching when callId is absent", () => {
  const state = fold([
    { type: "tool-call", name: "glob", arguments: { pattern: "*.ts" } },
    { type: "tool-result", name: "glob", output: "a.ts" },
  ]);
  const tool = state.blocks[0]!;
  assert.equal(tool.kind === "tool" ? tool.tool.status : "", "done");
  assert.equal(tool.kind === "tool" ? tool.tool.output : "", "a.ts");
});

test("run-state: unknown tool/result is ignored (no crash, no new block)", () => {
  const state = fold([
    { type: "tool-call", callId: "c1", name: "read" },
    { type: "tool-result", callId: "other", output: "x" },
  ]);
  assert.equal(state.blocks.length, 1);
  const tool = state.blocks[0]!;
  assert.equal(tool.kind === "tool" ? tool.tool.status : "", "running");
});

test("run-state: turn-end maps DSH reasons to terminals (completed/aborted/error)", () => {
  const c = clock();
  let state = fold([{ type: "text-delta", text: "hi" }], c);
  c.advance(2500);
  state = reduceRunView(state, { type: "turn-end", reason: "completed" }, c.now);
  assert.equal(state.terminal, "done");
  assert.equal(state.footer, null);
  assert.equal(state.finishedAt, 3_500);
  assert.equal((state.blocks[0] as { streaming: boolean }).streaming, false);

  const interrupted = fold([{ type: "turn-end", reason: "aborted" }]);
  assert.equal(interrupted.terminal, "interrupted");

  const failed = fold([
    { type: "turn-end", reason: "error", errorMessage: "UNKNOWN: model down" },
  ]);
  assert.equal(failed.terminal, "error");
  assert.equal(failed.errorMsg, "UNKNOWN: model down");
});

test("run-state: markRunInterrupted only affects running views", () => {
  const running = markRunInterrupted(createRunView());
  assert.equal(running.terminal, "interrupted");
  assert.equal(running.footer, null);

  const done = finalizeRunView(running);
  assert.equal(done.terminal, "interrupted", "an already-terminal view is not overridden");
});

test("run-state: finalizeRunView settles a running turn as done", () => {
  const state = finalizeRunView(createRunView());
  assert.equal(state.terminal, "done");
});

test("run-state: runViewText / runViewToolCount / runViewHasContent helpers", () => {
  const withStream = fold([
    { type: "tool-call", name: "bash", arguments: {} },
    { type: "text-delta", text: "done" },
  ]);
  assert.equal(runViewText(withStream), "done");
  assert.equal(runViewToolCount(withStream), 1);
  assert.equal(runViewHasContent(withStream), true);

  const empty = createRunView();
  assert.equal(runViewText(empty), "");
  assert.equal(runViewToolCount(empty), 0);
  assert.equal(runViewHasContent(empty), false);
});
