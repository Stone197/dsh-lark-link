// CardKit schema 2.0 renderer for the live Feishu run card.
//
// One run = one card:
//   🧠 reasoning collapsible panel (expanded while thinking, "点击查看" after)
//   text blocks as markdown
//   ✅/❌/⏳ tool panels (friendly title + DSH id + arg summary + input/output)
//      · fewer than 3 tools → each panel on its own
//      · ≥3 tools while running → prior tools collapse to "☕ N 个工具调用",
//        the LATEST one stays expanded for live observation
//      · ≥3 tools when finalized → one fully collapsed summary panel
//   terminal note (中断 / 出错 / 未返回内容)
//   footer status + ⏹ 终止 button while running
//
// Ported/adapted from zarazhangrui/lark-coding-agent-bridge src/card/run-renderer.ts.

import type {
  RunFooter,
  RunToolEntry,
  RunViewState,
} from "./run-state.ts";
import { runViewToolCount } from "./run-state.ts";
import { toolBodyMd, toolHeaderText } from "./run-tool-render.ts";

export const REASONING_MAX = 1500;
export const TOOL_COLLAPSE_THRESHOLD = 3;

export interface RunCardRenderOptions {
  /**
   * Signed stop-callback token (anti-forgery, see outbound/run-callback.ts).
   * Rendered as `run_cb` on the button value; the value keeps `op:"stop"` so
   * the existing card-action dispatcher still routes a click to `/stop` even
   * before signature verification is wired.
   */
  stopToken?: string;
}

interface ToolGroup {
  kind: "tools";
  tools: RunToolEntry[];
}
interface TextGroup {
  kind: "text";
  content: string;
}
type Group = ToolGroup | TextGroup;

/** Build the whole card JSON for the current run view. */
export function renderRunCard(
  state: RunViewState,
  options: RunCardRenderOptions = {},
): object {
  const elements: object[] = [];

  if (state.reasoning.content.trim() !== "") {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === "text") {
      if (group.content.trim() !== "") elements.push(markdown(group.content));
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== "running"));
    }
  }

  if (state.terminal === "interrupted") {
    elements.push(noteMd("_⏹ 已被中断_"));
  } else if (state.terminal === "error") {
    elements.push(
      noteMd(
        state.errorMsg
          ? `⚠️ agent 失败：${truncate(state.errorMsg, 300)}`
          : "⚠️ agent 失败",
      ),
    );
  } else if (state.terminal === "done" && elements.length === 0) {
    elements.push(noteMd("_（未返回内容）_"));
  }

  if (state.terminal === "running") {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: state.terminal === "running",
      summary: { content: buildRunSummary(state) },
    },
    body: { elements },
  };
}

/** Card list-summary line (shown in the chat list / card preview). */
export function buildRunSummary(state: RunViewState): string {
  if (state.terminal === "interrupted") return "已中断";
  if (state.terminal === "error") return "出错";
  if (state.terminal === "done") {
    const tools = runViewToolCount(state);
    const parts = ["已完成"];
    if (tools > 0) parts.push(`${tools} 个工具`);
    if (state.startedAt > 0 && state.finishedAt !== undefined) {
      const seconds = Math.max(0, Math.round((state.finishedAt - state.startedAt) / 1000));
      if (seconds > 0) parts.push(`${seconds}s`);
    }
    return parts.join(" · ");
  }
  return footerLabel(state.footer);
}

function* groupBlocks(blocks: RunViewState["blocks"]): Generator<Group> {
  let toolBuf: RunToolEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "tool") {
      toolBuf.push(block.tool);
      continue;
    }
    if (toolBuf.length > 0) {
      yield { kind: "tools", tools: toolBuf };
      toolBuf = [];
    }
    yield { kind: "text", content: block.content };
  }
  if (toolBuf.length > 0) yield { kind: "tools", tools: toolBuf };
}

function renderToolGroup(tools: RunToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < TOOL_COLLAPSE_THRESHOLD) {
    return tools.map((tool) => toolPanel(tool, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep the latest visible for live observation.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1]!;
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  return collapsiblePanel({
    title: active ? "🧠 **思考中**" : "🧠 **思考完成，点击查看**",
    expanded: active,
    border: "grey",
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: RunToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === "error" ? "red" : "grey",
    body: toolBodyMd(tool) || "_无输出_",
  });
}

/**
 * N tool calls as ONE collapsed panel. Body content is dropped on purpose:
 * rendering every input/output would push the serialized card toward Feishu's
 * per-element size limit; the header line keeps icon + name + arg digest.
 */
function collapsedToolSummary(tools: RunToolEntry[], finalized: boolean): object {
  const suffix = finalized ? "（已结束）" : "";
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((tool) => `- ${toolHeaderText(tool)}`).join("\n");
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: panelHeader(title),
    border: { color: "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: headerList, text_size: "notation" }],
  };
}

interface PanelOptions {
  title: string;
  expanded: boolean;
  border: "grey" | "red" | "blue";
  body: string;
}

function collapsiblePanel(opts: PanelOptions): object {
  return {
    tag: "collapsible_panel",
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: opts.body, text_size: "notation" }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function noteMd(content: string): object {
  return { tag: "markdown", content, text_size: "notation" };
}

/** ⏹ 终止 button — routes through the existing card.action.trigger path (`op:"stop"`). */
function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { op: "stop" };
  if (options.stopToken) {
    value.run_cb = true;
    value.token = options.stopToken;
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: "⏹ 终止" },
    type: "danger",
    behaviors: [{ type: "callback", value }],
  };
}

function footerLabel(status: RunFooter): string {
  if (status === "tool_running") return "正在调用工具";
  if (status === "streaming") return "正在输出";
  if (status === "thinking") return "正在思考";
  return "运行中";
}

function footerText(status: RunFooter): string {
  if (status === "tool_running") return "🧰 正在调用工具";
  if (status === "streaming") return "✍️ 正在输出";
  if (status === "thinking") return "🧠 正在思考";
  return "运行中";
}

function footerStatus(status: Exclude<RunFooter, null>): object {
  return noteMd(footerText(status));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
