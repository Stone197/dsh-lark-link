// Tool call rendering for the live Feishu run card.
//
// Header:   ✅/❌/⏳ + friendly Chinese title + DSH snake_case id + arg summary
// Body:     **输入** code fence (JSON) + **输出**/**Error** code fence
//
// Caps exist because Feishu rejects oversized card elements (~30KB) and that
// 400 aborts the whole card stream:
//   - header summary: 80 chars, single line
//   - one body field: 800 chars
//   - tool output:    1200 chars
//   - whole tool body: 2500 chars (belt across input+output+fences)
//
// Friendly names mirror the DSH desktop/WeChat presentation vocabulary
// (dsh-wechat src/adapter/process-format.ts TITLES).

import type { RunToolEntry } from "./run-state.ts";

export const HEADER_SUMMARY_MAX = 80;
export const BODY_FIELD_MAX = 800;
export const OUTPUT_MAX = 1200;
export const BODY_TOTAL_MAX = 2500;

/**
 * DSH snake_case tool id → friendly title. Source of truth: dsh-wechat's
 * `process-format.ts` TITLES (the desktop tool-row vocabulary); unknown ids
 * fall back to the raw id so new tools still render.
 */
export const TOOL_TITLES: Record<string, string> = {
  read: "读取",
  read_image: "读取图片",
  write: "写入",
  edit: "编辑",
  apply_patch: "编辑",
  bash: "运行命令",
  pwsh: "运行命令",
  exec_command: "运行命令",
  write_stdin: "运行命令",
  grep: "搜索文件内容",
  glob: "查找文件",
  web_search: "网页搜索",
  web_fetch: "网页获取",
  run_code: "代码",
  todo_write: "更新任务清单",
  ask_user_question: "提问",
  request_user_input: "提问",
  create_goal: "创建目标",
  get_goal: "查看目标",
  update_goal: "更新目标",
  schedule_create: "创建定时任务",
  schedule_list: "查看定时任务",
  schedule_delete: "删除定时任务",
  schedule_update: "修改定时任务",
  cordis_inspect_list: "检查提供方",
  cordis_inspect_query: "查询运行时",
  cordis_inspect_self: "检查动态插件",
  cordis_package_inspect: "查询 Cordis 环境",
  cordis_runtime_inspect: "查询 Cordis 环境",
  cordis_run: "运行 Cordis 插件",
  cordis_stop: "停止 Cordis 插件",
  cordis_undefine: "移除 Cordis 插件",
  workflow: "运行工作流",
  ralph: "运行循环工作流",
  session_event_read: "读取事件",
  session_event_search: "搜索事件",
  session_event_trace: "追踪事件",
  session_search: "搜索会话",
  session_trace: "追踪会话",
  list_subagent_models: "查看可用模型",
  subagent: "创建子智能体",
  list_agents: "查看子智能体",
  send_message: "发送消息",
  interrupt_agent: "中断智能体",
  job_list: "查看后台任务",
  job_output: "读取任务输出",
  job_kill: "取消后台任务",
  terminal_open: "创建终端",
  terminal_read: "读取终端",
  terminal_list: "查看终端",
  terminal_signal: "发送终端信号",
  terminal_close: "关闭终端",
  lsp: "查询代码符号",
  spawn_teammate: "创建队友",
  team_task_create: "创建团队任务",
  team_task_get: "读取团队任务",
  team_task_update: "更新团队任务",
  team_task_list: "查看团队任务",
  wait_agent: "等待子智能体",
};

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

/** Header summary keys per tool family (same order as the desktop summary). */
const SUMMARY_KEYS: Record<string, readonly string[]> = {
  bash: ["description", "command", "cmd"],
  pwsh: ["description", "command", "cmd"],
  exec_command: ["description", "command", "cmd"],
  write_stdin: ["description", "command", "cmd"],
  read: ["path", "file_path"],
  read_image: ["path", "file_path"],
  web_fetch: ["url", "path"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  apply_patch: ["path", "file_path"],
  grep: ["query", "pattern", "url"],
  glob: ["query", "pattern", "url"],
  web_search: ["query", "pattern", "url"],
  run_code: ["description"],
};

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringArg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

/** One-line, human-friendly argument digest for the tool header. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === "string") {
    const raw = firstLine(input);
    return raw ? truncate(oneLine(raw), HEADER_SUMMARY_MAX) : "";
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const keys = SUMMARY_KEYS[name] ?? ["description", "command", "query", "path", "file_path", "url"];
  let picked: string | undefined;
  for (const key of keys) {
    picked = stringArg(input, key);
    if (picked) break;
  }
  if (!picked) {
    // Fall back to the first non-empty string field so unknown tools still
    // show something meaningful instead of a bare header.
    for (const value of Object.values(input as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim() !== "") {
        picked = value;
        break;
      }
    }
  }
  return picked ? truncate(oneLine(picked), HEADER_SUMMARY_MAX) : "";
}

export function toolHeaderText(tool: RunToolEntry): string {
  const icon =
    tool.status === "done" ? "✅" : tool.status === "error" ? "❌" : "⏳";
  const title = toolTitle(tool.name);
  // Show the friendly title AND the DSH id (users grep for `bash`/`read`).
  const label = title === tool.name ? `**${title}**` : `**${title}** \`${tool.name}\``;
  const summary = summarizeToolInput(tool.name, tool.input);
  return summary ? `${icon} ${label} — ${summary}` : `${icon} ${label}`;
}

function renderInputBody(tool: RunToolEntry): string {
  const input = tool.input;
  if (input === undefined || input === null) return "";
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = JSON.stringify(input, null, 2) ?? "";
    } catch {
      text = String(input);
    }
  }
  if (text.trim() === "") return "";
  return `**输入**\n\`\`\`json\n${truncate(text, BODY_FIELD_MAX)}\n\`\`\``;
}

function renderOutputBody(tool: RunToolEntry): string {
  const body = tool.errorText ?? tool.output;
  if (tool.status === "running" && !body) return "_运行中…_";
  if (!body) return "";
  const label = tool.status === "error" ? "**Error**" : "**输出**";
  return `${label}\n\`\`\`\n${truncate(body, OUTPUT_MAX)}\n\`\`\``;
}

/** Full markdown body of one tool panel (input + output, capped). */
export function toolBodyMd(tool: RunToolEntry): string {
  const parts = [renderInputBody(tool), renderOutputBody(tool)].filter(
    (p) => p !== "",
  );
  const body = parts.join("\n\n");
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（工具详情已截断）_`;
}
