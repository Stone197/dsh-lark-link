import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRunView,
  reduceRunView,
  type RunViewState,
} from "../../../src/presentation/run-state.ts";
import {
  buildRunSummary,
  renderRunCard,
  REASONING_MAX,
  TOOL_COLLAPSE_THRESHOLD,
} from "../../../src/presentation/run-renderer.ts";
import { BODY_TOTAL_MAX, OUTPUT_MAX, toolBodyMd } from "../../../src/presentation/run-tool-render.ts";

interface CardElement {
  tag: string;
  content?: string;
  expanded?: boolean;
  type?: string;
  header?: { title?: { content?: string } };
  border?: { color?: string };
  elements?: CardElement[];
  behaviors?: Array<{ value?: Record<string, unknown> }>;
}

interface Card {
  schema: string;
  config: {
    streaming_mode?: boolean;
    update_multi?: boolean;
    summary?: { content?: string };
  };
  body: { elements: CardElement[] };
}

function asCard(card: unknown): Card {
  return card as Card;
}

function elements(card: unknown): CardElement[] {
  return asCard(card).body.elements;
}

function panels(card: unknown): CardElement[] {
  return elements(card).filter((e) => e.tag === "collapsible_panel");
}

function panelTitle(panel: CardElement): string {
  return panel.header?.title?.content ?? "";
}

function fold(events: Parameters<typeof reduceRunView>[1][]): RunViewState {
  let state = createRunView(() => 1_000);
  for (const event of events) state = reduceRunView(state, event, () => 1_000);
  return state;
}

test("run-renderer: running card is schema 2.0 with streaming_mode + summary", () => {
  const state = fold([
    { type: "reasoning-delta", text: "thinking" },
    { type: "text-delta", text: "hello" },
  ]);
  const card = asCard(renderRunCard(state));
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.summary?.content, "正在输出");
  assert.ok(elements(card).some((e) => e.tag === "markdown" && e.content === "hello"));
});

test("run-renderer: reasoning panel expands while active and collapses after", () => {
  const active = fold([{ type: "reasoning-delta", text: "chain of thought" }]);
  const activePanel = panels(renderRunCard(active))[0]!;
  assert.equal(activePanel.expanded, true);
  assert.match(panelTitle(activePanel), /思考中/);
  assert.equal(activePanel.elements?.[0]?.content, "chain of thought");

  const finished = fold([
    { type: "reasoning-delta", text: "chain" },
    { type: "message", text: "answer", reasoning: "chain of thought" },
  ]);
  const finishedPanel = panels(renderRunCard(finished))[0]!;
  assert.equal(finishedPanel.expanded, false);
  assert.match(panelTitle(finishedPanel), /思考完成，点击查看/);
});

test("run-renderer: reasoning content is capped", () => {
  const long = "x".repeat(REASONING_MAX + 200);
  const state = fold([{ type: "reasoning-delta", text: long }]);
  const panel = panels(renderRunCard(state))[0]!;
  const body = panel.elements?.[0]?.content ?? "";
  assert.equal(body.length, REASONING_MAX + 1);
  assert.ok(body.endsWith("…"));
});

test("run-renderer: one tool renders a single panel with friendly title + DSH id + digest", () => {
  const state = fold([
    {
      type: "tool-call",
      callId: "c1",
      name: "bash",
      arguments: { command: "pnpm run test" },
    },
  ]);
  const toolPanels = panels(renderRunCard(state));
  assert.equal(toolPanels.length, 1);
  const title = panelTitle(toolPanels[0]!);
  assert.match(title, /⏳/);
  assert.match(title, /运行命令/);
  assert.match(title, /`bash`/);
  assert.match(title, /pnpm run test/);
  assert.match(toolPanels[0]!.elements?.[0]?.content ?? "", /输入/);
  assert.match(toolPanels[0]!.elements?.[0]?.content ?? "", /运行中/);
});

test("run-renderer: finished tool shows ✅ + output; failed tool shows ❌ + red border", () => {
  const done = fold([
    { type: "tool-call", callId: "c1", name: "read", arguments: { file_path: "/src/a.ts" } },
    { type: "tool-result", callId: "c1", output: "file content" },
  ]);
  const donePanel = panels(renderRunCard(done))[0]!;
  assert.match(panelTitle(donePanel), /✅/);
  assert.match(panelTitle(donePanel), /读取/);
  assert.match(donePanel.elements?.[0]?.content ?? "", /file content/);

  const failed = fold([
    { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "false" } },
    { type: "tool-result", callId: "c1", output: "exit 1", isError: true },
  ]);
  const failedPanel = panels(renderRunCard(failed))[0]!;
  assert.match(panelTitle(failedPanel), /❌/);
  assert.equal(failedPanel.border?.color, "red");
  assert.match(failedPanel.elements?.[0]?.content ?? "", /Error/);
});

test("run-renderer: <3 tools → each panel expanded false, no collapse summary", () => {
  const state = fold([
    { type: "tool-call", callId: "c1", name: "read", arguments: {} },
    { type: "tool-result", callId: "c1", output: "a" },
    { type: "tool-call", callId: "c2", name: "glob", arguments: {} },
  ]);
  const rendered = panels(renderRunCard(state));
  assert.equal(TOOL_COLLAPSE_THRESHOLD, 3);
  assert.equal(rendered.length, 2);
  assert.equal(rendered.every((p) => p.expanded === false), true);
});

test("run-renderer: ≥3 tools while running → prior collapsed, latest expanded", () => {
  const state = fold([
    { type: "tool-call", callId: "c1", name: "read", arguments: {} },
    { type: "tool-result", callId: "c1", output: "a" },
    { type: "tool-call", callId: "c2", name: "grep", arguments: { pattern: "x" } },
    { type: "tool-result", callId: "c2", output: "b" },
    { type: "tool-call", callId: "c3", name: "bash", arguments: { command: "ls" } },
  ]);
  const rendered = panels(renderRunCard(state));
  assert.equal(rendered.length, 2);
  assert.match(panelTitle(rendered[0]!), /☕ \*\*2 个工具调用\*\*/);
  assert.equal(rendered[0]!.expanded, false);
  // latest stays open for live observation
  assert.equal(rendered[1]!.expanded, true);
  assert.match(panelTitle(rendered[1]!), /⏳/);
  assert.match(panelTitle(rendered[1]!), /`bash`/);
});

test("run-renderer: ≥3 tools when finalized → ONE collapsed 'N 个工具调用（已结束）'", () => {
  let state = fold([
    { type: "tool-call", callId: "c1", name: "read", arguments: {} },
    { type: "tool-result", callId: "c1", output: "a" },
    { type: "tool-call", callId: "c2", name: "grep", arguments: {} },
    { type: "tool-result", callId: "c2", output: "b" },
    { type: "tool-call", callId: "c3", name: "bash", arguments: {} },
    { type: "tool-result", callId: "c3", output: "c" },
  ]);
  state = reduceRunView(state, { type: "turn-end", reason: "completed" }, () => 1_000);
  const rendered = panels(renderRunCard(state));
  assert.equal(rendered.length, 1);
  assert.match(panelTitle(rendered[0]!), /☕ \*\*3 个工具调用（已结束）\*\*/);
  assert.equal(rendered[0]!.expanded, false);
  // bodies are dropped in the collapsed summary (only header lines remain)
  const body = rendered[0]!.elements?.[0]?.content ?? "";
  assert.match(body, /- ✅ \*\*读取\*\*/);
  assert.doesNotMatch(body, /file content/);
});

test("run-renderer: tool output is capped at OUTPUT_MAX and body at BODY_TOTAL_MAX", () => {
  const long = "y".repeat(OUTPUT_MAX + 500);
  const state = fold([
    { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "cat big" } },
    { type: "tool-result", callId: "c1", output: long },
  ]);
  const tool = state.blocks[0]!;
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") return;
  const body = toolBodyMd(tool.tool);
  assert.ok(body.length <= BODY_TOTAL_MAX + 40);
  assert.doesNotMatch(body, new RegExp("y".repeat(OUTPUT_MAX + 1)));
});

test("run-renderer: running card renders footer + ⏹ 终止 button (op stop)", () => {
  const state = fold([
    { type: "tool-call", name: "bash", arguments: {} },
  ]);
  const card = asCard(renderRunCard(state));
  const footer = card.body.elements.find(
    (e) => e.tag === "markdown" && (e.content ?? "").includes("正在调用工具"),
  );
  assert.ok(footer, "footer status line present");
  const button = card.body.elements.find((e) => e.tag === "button");
  assert.ok(button, "stop button present");
  assert.equal(button!.behaviors?.[0]?.value?.op, "stop");
  assert.equal(button!.behaviors?.[0]?.value?.token, undefined);
});

test("run-renderer: signed stop token is embedded in the button value", () => {
  const card = asCard(renderRunCard(createRunView(), { stopToken: "runcb.v1.x.y" }));
  const button = card.body.elements.find((e) => e.tag === "button")!;
  assert.equal(button.behaviors?.[0]?.value?.op, "stop");
  assert.equal(button.behaviors?.[0]?.value?.run_cb, true);
  assert.equal(button.behaviors?.[0]?.value?.token, "runcb.v1.x.y");
});

test("run-renderer: terminal cards render the matching note and no stop button", () => {
  const interrupted = reduceRunView(createRunView(), { type: "turn-end", reason: "aborted" });
  const interruptedCard = asCard(renderRunCard(interrupted));
  assert.equal(interruptedCard.config.streaming_mode, false);
  assert.ok(
    interruptedCard.body.elements.some((e) => (e.content ?? "").includes("已被中断")),
  );
  assert.equal(interruptedCard.body.elements.some((e) => e.tag === "button"), false);

  const error = reduceRunView(createRunView(), {
    type: "turn-end",
    reason: "error",
    errorMessage: "model down",
  });
  const errorCard = asCard(renderRunCard(error));
  assert.ok(errorCard.body.elements.some((e) => (e.content ?? "").includes("model down")));

  const empty = reduceRunView(createRunView(), { type: "turn-end", reason: "completed" });
  const emptyCard = asCard(renderRunCard(empty));
  assert.ok(emptyCard.body.elements.some((e) => (e.content ?? "").includes("未返回内容")));
});

test("run-renderer: done summary counts tools + elapsed seconds", () => {
  let state = createRunView(() => 1_000);
  state = reduceRunView(state, { type: "tool-call", callId: "c1", name: "read" }, () => 1_000);
  state = reduceRunView(state, { type: "tool-result", callId: "c1", output: "a" }, () => 1_000);
  state = reduceRunView(state, { type: "turn-end", reason: "completed" }, () => 4_500);
  assert.equal(buildRunSummary(state), "已完成 · 1 个工具 · 4s");

  const interrupted = reduceRunView(createRunView(), { type: "turn-end", reason: "aborted" });
  assert.equal(buildRunSummary(interrupted), "已中断");
  const failed = reduceRunView(createRunView(), { type: "turn-end", reason: "error" });
  assert.equal(buildRunSummary(failed), "出错");
});
