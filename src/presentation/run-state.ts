// Run view state machine for the live Feishu run card ("一次运行 = 一张实时卡片").
//
// Pure reducer over normalized run events (src/common/types.ts RunBridgeEvent):
// text blocks, a single reasoning stream, tool call panels, footer status and a
// terminal state. The renderer (run-renderer.ts) turns this state into a
// CardKit schema 2.0 card; the outbound forwarder owns the lifecycle.
//
// Ported/adapted from zarazhangrui/lark-coding-agent-bridge src/card/run-state.ts
// but keyed on DSH's event vocabulary (callId, tool snake_case ids, aborted).

export type ToolStatus = "running" | "done" | "error";

/** One tool invocation panel. */
export interface RunToolEntry {
  /** DSH `ToolCallId` — pairs the call with its result (may be absent in mocks). */
  id?: string;
  /** DSH snake_case tool id, e.g. `bash`, `read`, `web_search`. */
  name: string;
  /** Parsed JSON arguments when the raw string parsed, else the raw string. */
  input?: unknown;
  status: ToolStatus;
  /** Tool result text (joined content blocks), truncated only at render time. */
  output?: string;
  /** Failure text (structured error or the result message itself). */
  errorText?: string;
}

export type RunBlock =
  | { kind: "text"; content: string; streaming: boolean }
  | { kind: "tool"; tool: RunToolEntry };

export type RunFooter = "thinking" | "tool_running" | "streaming" | null;

export type RunTerminal = "running" | "done" | "interrupted" | "error";

export interface ReasoningState {
  content: string;
  /** True while the model is actively streaming reasoning. */
  active: boolean;
}

export interface RunViewState {
  blocks: RunBlock[];
  reasoning: ReasoningState;
  footer: RunFooter;
  terminal: RunTerminal;
  errorMsg?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Normalized events consumed by the reducer (subset of RunBridgeEvent). */
export type RunViewEvent =
  | { type: "text-delta"; text: string }
  | { type: "message"; text: string; reasoning?: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId?: string; name: string; arguments?: unknown }
  | {
      type: "tool-result";
      callId?: string;
      name?: string;
      output?: string;
      isError?: boolean;
      error?: { name: string; code: string };
    }
  | { type: "turn-end"; reason: string; errorMessage?: string }
  | { type: "interrupt" };

export function createRunView(now: () => number = Date.now): RunViewState {
  return {
    blocks: [],
    reasoning: { content: "", active: false },
    footer: "thinking",
    terminal: "running",
    startedAt: now(),
  };
}

function closeStreamingText(blocks: RunBlock[]): RunBlock[] {
  return blocks.map((b) =>
    b.kind === "text" && b.streaming ? { ...b, streaming: false } : b,
  );
}

function reasoningDone(state: ReasoningState): ReasoningState {
  return state.active ? { ...state, active: false } : state;
}

/** Append a visible-text delta, extending the trailing streaming text block. */
function appendText(blocks: RunBlock[], delta: string): RunBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text" && last.streaming) {
    return [...blocks.slice(0, -1), { ...last, content: last.content + delta }];
  }
  return [...blocks, { kind: "text", content: delta, streaming: true }];
}

/**
 * Settle one complete assistant message. DSH emits the assembled message after
 * the streamed chunks, so prefer the message text (it is the durable version)
 * over whatever was accumulated from deltas; an empty message adds no block.
 */
function settleMessage(blocks: RunBlock[], text: string): RunBlock[] {
  const closed = blocks.map((b): RunBlock =>
    b.kind === "text" && b.streaming ? { ...b, streaming: false } : b,
  );
  if (!text) return closed;
  const last = closed[closed.length - 1];
  if (last && last.kind === "text") {
    if (last.streaming === false && last.content === text) return closed; // already settled
    // Only the streaming tail belongs to THIS message; a settled text block
    // came from an earlier step and must never be overwritten.
    if (last.streaming === true || text.length >= last.content.length) {
      const content = text.length >= last.content.length ? text : last.content;
      return [...closed.slice(0, -1), { ...last, content, streaming: false }];
    }
  }
  return [...closed, { kind: "text", content: text, streaming: false }];
}

function mapTerminal(reason: string): RunTerminal {
  switch (reason) {
    case "aborted":
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "error":
    case "failed":
    case "rejected":
      return "error";
    default:
      // completed / max-tokens / blocked / timeout / unknown → the run ended.
      return "done";
  }
}

/** Find the tool entry a result belongs to: by callId, else the latest running match. */
function findToolIndex(
  blocks: RunBlock[],
  callId: string | undefined,
  name: string | undefined,
): number {
  if (callId !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "tool" && b.tool.id === callId) return i;
    }
    // A callId was supplied: it is authoritative. Do not fall back to a
    // name match — an unrelated result must never settle another tool.
    return -1;
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind !== "tool" || b.tool.status !== "running") continue;
    if (name === undefined || b.tool.name === name) return i;
  }
  return -1;
}

function applyToolResult(state: RunViewState, ev: Extract<RunViewEvent, { type: "tool-result" }>): RunViewState {
  const idx = findToolIndex(state.blocks, ev.callId, ev.name);
  if (idx === -1) return state;
  const block = state.blocks[idx]!;
  if (block.kind !== "tool") return state;
  const failed = ev.isError === true || ev.error !== undefined;
  const errorText = failed
    ? (ev.output && ev.output.trim() !== ""
        ? ev.output
        : ev.error
          ? `${ev.error.name}: ${ev.error.code}`
          : "工具执行失败")
    : undefined;
  const tool: RunToolEntry = {
    ...block.tool,
    status: failed ? "error" : "done",
    output: ev.output && ev.output !== "" ? ev.output : block.tool.output,
    errorText: errorText ?? block.tool.errorText,
  };
  return {
    ...state,
    blocks: [...state.blocks.slice(0, idx), { kind: "tool", tool }, ...state.blocks.slice(idx + 1)],
  };
}

/** Fold one normalized run event into the live run view. */
export function reduceRunView(
  state: RunViewState,
  event: RunViewEvent,
  now: () => number = Date.now,
): RunViewState {
  switch (event.type) {
    case "text-delta": {
      if (event.text === "") return state;
      return {
        ...state,
        blocks: appendText(state.blocks, event.text),
        reasoning: reasoningDone(state.reasoning),
        footer: "streaming",
      };
    }
    case "message": {
      const reasoning =
        event.reasoning !== undefined
          ? { content: event.reasoning, active: false }
          : reasoningDone(state.reasoning);
      return {
        ...state,
        blocks: settleMessage(state.blocks, event.text),
        reasoning,
        footer: "streaming",
      };
    }
    case "reasoning-delta": {
      if (event.text === "") return state;
      return {
        ...state,
        reasoning: { content: state.reasoning.content + event.text, active: true },
        footer: "thinking",
      };
    }
    case "tool-call": {
      const tool: RunToolEntry = {
        id: event.callId,
        name: event.name,
        input: event.arguments,
        status: "running",
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: "tool", tool }],
        reasoning: reasoningDone(state.reasoning),
        footer: "tool_running",
      };
    }
    case "tool-result": {
      const next = applyToolResult(state, event);
      if (next === state) return state;
      const anyRunning = next.blocks.some(
        (b) => b.kind === "tool" && b.tool.status === "running",
      );
      return anyRunning ? { ...next, footer: "tool_running" } : next;
    }
    case "turn-end": {
      const terminal = mapTerminal(event.reason);
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        errorMsg:
          terminal === "error" && event.errorMessage
            ? event.errorMessage
            : state.errorMsg,
        footer: null,
        finishedAt: now(),
      };
    }
    case "interrupt": {
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: "interrupted",
        footer: null,
        finishedAt: now(),
      };
    }
    default:
      return state;
  }
}

/** Force a still-running view into the interrupted terminal state (/stop). */
export function markRunInterrupted(
  state: RunViewState,
  now: () => number = Date.now,
): RunViewState {
  if (state.terminal !== "running") return state;
  return reduceRunView(state, { type: "interrupt" }, now);
}

/** Settle a still-running view as done (turn/end without a reason). */
export function finalizeRunView(
  state: RunViewState,
  now: () => number = Date.now,
): RunViewState {
  if (state.terminal !== "running") return state;
  return reduceRunView(state, { type: "turn-end", reason: "completed" }, now);
}

/** All visible assistant text of the run (used by the outbox fallback). */
export function runViewText(state: RunViewState): string {
  return state.blocks
    .filter((b): b is Extract<RunBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.content)
    .join("");
}

export function runViewToolCount(state: RunViewState): number {
  return state.blocks.filter((b) => b.kind === "tool").length;
}

/** True when the card has anything user-visible (text, reasoning or tools). */
export function runViewHasContent(state: RunViewState): boolean {
  return (
    runViewText(state).trim() !== "" ||
    state.reasoning.content.trim() !== "" ||
    runViewToolCount(state) > 0
  );
}
