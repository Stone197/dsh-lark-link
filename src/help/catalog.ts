/**
 * The command-help catalog — the SINGLE source of every user-facing help
 * string, shared by BOTH IM channels of the unified bridge.
 *
 * The WeChat view is ported from `pan17/dsh-wechat` v0.13.3 `src/help-catalog.ts`
 * (MIT); the Feishu view (`feishu-*` groups) was added when the two channels
 * were merged into one package.
 *
 *   - Feishu: `/help` renders a button card (`src/presentation/cards.ts`
 *     `helpCard()`) generated from `feishuHelpCatalog()`; `/ws list` and the
 *     settings console reuse the same wording.
 *   - WeChat: the settings page (「指令帮助」) reads the catalog as JSON from
 *     `/wechat/api/help` (`catalog`) and renders its groups, commands and
 *     examples; WeChat's `/help` renders the SAME data as two-level Markdown —
 *     a one-line-per-command listing plus `/help <命令>` for one command's
 *     full example list (`bridge/slash.ts`, from `helpCatalog()`).
 *
 * So a wording change here lands in every surface at once, and neither channel
 * can document a command the other has never heard of. The two views are
 * derived from the same `GROUPS`/`COMMANDS` arrays: a group whose id starts
 * with `feishu-` belongs to the Feishu view, everything else is WeChat.
 *
 * Rules for editing (enforced by the WeChat header test in
 * `tests-wechat/help-catalog.test.ts` and by `test/unit/client/**` here):
 *
 *   - Every local command in WeChat's `formatHelp()` must appear here, and
 *     vice versa (the drift guard).
 *   - Every entry in `subcommands` must have at least one example using it, so
 *     a new subcommand cannot be documented by its absence.
 *   - Every `kind: "command"` example must actually be recognized by the
 *     bridge's slash parsers — the help must never advertise a line that the
 *     bridge would forward to the agent as chat.
 *   - Examples contain no `<placeholder>` angle brackets: a user copies a line
 *     and sends it. Concrete sample values are labelled in `note`.
 *   - `summary` is one sentence, ≤ 40 characters, no implementation jargon.
 *   - `aliases` holds SHORTENINGS only — a second full word is not listed even
 *     though the parser accepts it.
 */

export type HelpChannel = "feishu" | "wechat";

export type HelpGroupId =
  | "basics"
  | "navigate"
  | "model"
  | "pacing"
  | "reference"
  | "card"
  | "feishu-basics"
  | "feishu-session"
  | "feishu-model"
  | "feishu-ops";

export interface HelpGroup {
  id: HelpGroupId;
  title: string;
  blurb: string;
}

/**
 * One example line.
 *
 * `kind` is `"command"` for a real slash command the bridge recognizes, and
 * `"text"` for plain text the user types (the `..` / `!!` merge suffixes are
 * message text, not commands — calling them commands would be a lie the test
 * suite cannot catch any other way).
 */
export interface HelpExample {
  line: string;
  note: string;
  kind?: "command" | "text";
}

export interface HelpCommandEntry {
  id: string;
  /** Leading-slash spelling, e.g. `/session`. */
  command: string;
  /**
   * Alternate spellings the bridge accepts, without the slash.
   *
   * Only SHORTENINGS belong here (`s`, `ws`, `p`, `sl`, `fo`, `f`, `mg`,
   * `md`, `h`, `?`). A second full word (`permission`, `busy`, `watch`,
   * `notice`, `wxprompt`) is deliberately NOT listed: the parser still accepts
   * it, but showing `/notify (watch, notice)` reads as three commands in a row
   * and made the WeChat `/help` listing unreadable.
   */
  aliases: string[];
  /**
   * One short, neutral sentence: what the command does.
   *
   * Written in a technical register, not conversational prose — the SAME
   * string is rendered in the settings panel AND in WeChat's `/help` table, so
   * "别憋了，现在就把暂存的结论发给我" would read as chatty noise in a
   * monospace listing. Aim for "立即发送暂存的结论": short, plain, no slang.
   */
  summary: string;
  /** Grammar string, shown as secondary text once the row is expanded. */
  usage: string;
  /**
   * Canonical subcommand keywords. Every one of them must be exercised by an
   * example (see the coverage test) — this is the field that keeps a
   * multi-subcommand entry from being documented by three of its ten forms.
   */
  subcommands: string[];
  examples: HelpExample[];
  group: HelpGroupId;
}

export interface HelpCatalog {
  intro: string;
  footer: string;
  groups: HelpGroup[];
  commands: HelpCommandEntry[];
}

const GROUPS: HelpGroup[] = [
  {
    id: "basics",
    title: "常用",
    blurb: "查看帮助、查看状态、中断任务。",
  },
  {
    id: "navigate",
    title: "会话与项目",
    blurb: "会话是一段独立的对话；项目是一个工作目录。",
  },
  {
    id: "model",
    title: "模型与权限",
    blurb: "选择模型、设置推理等级、设定可读写的文件范围。",
  },
  {
    id: "pacing",
    title: "输出节奏",
    blurb: "控制推送到微信的内容与时机。",
  },
  {
    id: "reference",
    title: "引用与回看",
    blurb: "引用其它会话或文件，或查看历史记录。",
  },
  {
    id: "card",
    title: "待处理卡片",
    blurb: "关闭等待确认的权限卡与提问卡。",
  },
  // ── Feishu view (`feishu-` prefix marks the channel) ──────────────────
  {
    id: "feishu-basics",
    title: "常用",
    blurb: "查看帮助与桥接状态，随时中断当前任务。",
  },
  {
    id: "feishu-session",
    title: "会话与项目",
    blurb: "会话是一段独立对话；工作区是它干活的目录。",
  },
  {
    id: "feishu-model",
    title: "模式、权限与模型",
    blurb: "切换 Agent 模式、权限级别和使用的模型。",
  },
  {
    id: "feishu-ops",
    title: "桥接与诊断",
    blurb: "启停桥接、热改配置、拉诊断包、跑长任务。",
  },
];

const INTROS: Record<HelpChannel, string> = {
  wechat:
    "以 / 开头的消息是指令。每条命令都可以展开查看示例，点击示例即可复制发送。",
  feishu:
    "以 / 开头是指令，也可以直接点卡片上的按钮执行。每条命令都附了可复制的示例。",
};

const FOOTERS: Record<HelpChannel, string> = {
  wechat:
    "DSH 原生命令（如 /plan、/goal、/compact）同样可在微信使用；发送 /help 可查看当前已注册的命令。",
  feishu:
    "其他 /xxx 与 skill 无需前缀，直接把任务发给机器人即可；上表之外的 DSH 原生命令同样可用。",
};

const COMMANDS: HelpCommandEntry[] = [
  // ── 常用 ────────────────────────────────────────────────────────────────
  {
    id: "help",
    command: "/help",
    aliases: ["h", "?"],
    summary: "查看指令清单与示例",
    usage: "/help | /help <命令名或简写>（也可以 /h 或 /?）",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/help", note: "全部指令一览" },
      { line: "/help s", note: "该命令的全部例子" },
      { line: "/help merge", note: "写全名也一样" },
      { line: "/h", note: "同 /help" },
      { line: "/?", note: "同 /help" },
    ],
  },
  {
    id: "status",
    command: "/status",
    aliases: [],
    summary: "查看当前状态",
    usage: "/status",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/status", note: "项目、会话、模型、权限、待处理卡片" },
    ],
  },
  {
    id: "stop",
    command: "/stop",
    aliases: [],
    summary: "中断当前任务",
    usage: "/stop",
    subcommands: [],
    group: "basics",
    examples: [{ line: "/stop", note: "已修改的文件不回滚" }],
  },
  {
    id: "next",
    command: "/next",
    aliases: [],
    summary: "继续发送被限流的消息",
    usage: "/next",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/next", note: "发送被微信挡下的消息" },
    ],
  },

  // ── 换会话 / 换项目 ──────────────────────────────────────────────────────
  {
    id: "session",
    command: "/session",
    aliases: ["s"],
    summary: "会话管理：列出、切换、置顶、新建",
    usage: "/session list [current] [all|数量] | switch [current] <编号> | pin [编号] | unpin [编号] | new | status（裸 /s 看状态）",
    subcommands: ["list", "list current", "switch", "switch current", "pin", "unpin", "new", "status"],
    group: "navigate",
    examples: [
      { line: "/s list", note: "最近 20 个会话（📌 为置顶）" },
      { line: "/s list current", note: "仅当前项目的会话" },
      { line: "/s list all", note: "全部会话" },
      { line: "/s switch 3", note: "切换到第 3 个（编号见 /s list）" },
      { line: "/s switch current 2", note: "当前项目列表第 2 个" },
      { line: "/s pin 3", note: "置顶第 3 个" },
      { line: "/s pin", note: "置顶当前会话" },
      { line: "/s unpin 3", note: "取消第 3 个的置顶" },
      { line: "/s unpin", note: "取消当前会话的置顶" },
      { line: "/s new", note: "新建会话" },
      { line: "/s status", note: "当前会话状态" },
    ],
  },
  {
    id: "workspace",
    command: "/workspace",
    aliases: ["ws"],
    summary: "工作区管理：列出、切换、添加",
    usage: "/workspace list [all|数量] | status | switch <编号|路径> | add <路径>（裸 /ws 看状态）",
    subcommands: ["list", "status", "switch", "add"],
    group: "navigate",
    examples: [
      { line: "/workspace list", note: "最近 20 个工作区" },
      { line: "/workspace list all", note: "全部工作区" },
      { line: "/workspace status", note: "当前工作区目录" },
      { line: "/workspace switch 2", note: "切换到第 2 个" },
      { line: "/workspace switch D:\\projects\\my-app", note: "按路径切换" },
      { line: "/workspace add D:\\projects\\new-app", note: "添加并切换" },
    ],
  },
  {
    id: "cd",
    command: "/cd",
    aliases: [],
    summary: "切换工作区（/workspace 简写）",
    usage: "/cd <路径>；与 /workspace switch <路径> 等价",
    subcommands: [],
    group: "navigate",
    examples: [
      { line: "/cd D:\\projects\\my-app", note: "按路径切换工作区" },
      { line: "/cd ~/work", note: "也支持 ~ 家目录写法" },
    ],
  },
  {
    id: "preset",
    command: "/preset",
    aliases: ["p"],
    summary: "Agent 预设管理",
    usage: "/preset list | switch <名称|编号> | status（裸 /p 看状态）",
    subcommands: ["list", "switch", "status"],
    group: "navigate",
    examples: [
      { line: "/p list", note: "列出预设" },
      { line: "/p switch 2", note: "切换到第 2 个" },
      { line: "/p switch build", note: "按名称切换" },
      { line: "/p status", note: "默认预设（影响新会话）" },
    ],
  },

  // ── 换模型 / 改权限 ──────────────────────────────────────────────────────
  {
    id: "model",
    command: "/model",
    aliases: [],
    summary: "模型管理：列出、切换",
    usage: "/model list [提供商] | switch <提供商/模型> | status（裸 /model 看状态）",
    subcommands: ["list", "switch", "status"],
    group: "model",
    examples: [
      { line: "/model list", note: "列出提供商" },
      { line: "/model list openrouter", note: "该提供商下的模型" },
      { line: "/model switch deepseek/deepseek-chat", note: "切换模型，立即生效" },
      { line: "/model status", note: "当前模型" },
    ],
  },
  {
    id: "reasoning",
    command: "/reasoning",
    aliases: [],
    summary: "推理等级设置",
    usage: "/reasoning [list | switch <等级> | default]",
    subcommands: ["list", "switch", "default"],
    group: "model",
    examples: [
      { line: "/reasoning", note: "当前档位与可用档位" },
      { line: "/reasoning list", note: "该模型支持的等级" },
      { line: "/reasoning switch high", note: "切换到 high" },
      { line: "/reasoning switch 高", note: "支持中文等级名" },
      { line: "/reasoning default", note: "恢复模型默认" },
    ],
  },
  {
    id: "perm",
    command: "/perm",
    aliases: [],
    summary: "权限管理：查看、切换、默认值",
    usage: "/perm status | list | switch <名称|编号> | default [名称|编号]（裸 /perm 看状态）",
    subcommands: ["list", "status", "switch", "default"],
    group: "model",
    examples: [
      { line: "/perm list", note: "列出权限档" },
      { line: "/perm status", note: "当前会话与新会话默认" },
      { line: "/perm switch 2", note: "当前会话切换，立即生效" },
      { line: "/perm switch workspace-write", note: "按名称切换，仅当前会话" },
      { line: "/perm default 1", note: "新会话默认第 1 档" },
      { line: "/perm default", note: "新会话默认档" },
    ],
  },
  {
    id: "enter",
    command: "/enter",
    aliases: [],
    summary: "繁忙时消息投递方式",
    usage: "/enter [status | queue | steer]",
    subcommands: ["status", "steer", "queue"],
    group: "model",
    examples: [
      { line: "/enter", note: "当前投递方式" },
      { line: "/enter status", note: "同上" },
      { line: "/enter steer", note: "插话：立即插入当前轮" },
      { line: "/enter queue", note: "排队：等待下一轮" },
      { line: "/enter 排队", note: "同 queue" },
    ],
  },

  // ── 回复太多？调节奏 ─────────────────────────────────────────────────────
  {
    id: "silent",
    command: "/silent",
    aliases: ["sl"],
    summary: "仅发送每轮最终回复",
    usage: "/silent on|off|status",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/silent on", note: "开启：仅最终回复" },
      { line: "/silent off", note: "关闭：显示过程" },
      { line: "/silent", note: "开启 / 关闭状态" },
      { line: "/silent status", note: "同上" },
    ],
  },
  {
    id: "final",
    command: "/final",
    aliases: ["fo"],
    summary: "结论模式：只发送最终结论",
    usage: "/final on|off|status（/f 是 /flush，不是这个）",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/final on", note: "开启；卡片与报错仍立即发送" },
      { line: "/final off", note: "关闭并发送暂存结论" },
      { line: "/final", note: "状态与暂存条数" },
      { line: "/final status", note: "同上" },
    ],
  },
  {
    id: "flush",
    command: "/flush",
    aliases: ["f"],
    summary: "立即发送暂存的结论",
    usage: "/flush（也可以 /f）",
    subcommands: [],
    group: "pacing",
    examples: [
      { line: "/flush", note: "取回暂存结论" },
      { line: "/f", note: "同上，非 /final 的缩写" },
    ],
  },
  {
    id: "merge",
    command: "/merge",
    aliases: ["mg"],
    summary: "打字合并：多条消息合成一轮",
    usage: "/merge on|off|status；正文末尾 `..` 继续追加、`!!` 立刻提交",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/merge on", note: "开启：静默窗口后合并" },
      { line: "/merge off", note: "关闭并发送暂存消息" },
      { line: "/merge", note: "窗口、上限、暂存条数" },
      { line: "/merge status", note: "窗口、上限、暂存条数" },
      { line: "帮我改下登录页 ..", note: "追加：先不发送（需先 /merge on）", kind: "text" },
      { line: "跑一下测试 !!", note: "立即提交（需先 /merge on）", kind: "text" },
    ],
  },
  {
    id: "media",
    command: "/media",
    aliases: ["md"],
    summary: "图片/文件与文字合并发送",
    usage: "/media on|off | at|path | status",
    subcommands: ["on", "off", "at", "path", "status"],
    group: "pacing",
    examples: [
      { line: "/media on", note: "开启：附件与下一条文字合并" },
      { line: "/media off", note: "关闭并发送暂存附件" },
      { line: "/media at", note: "附件写成 @引用" },
      { line: "/media path", note: "附件写成「已保存到: 路径」" },
      { line: "/media", note: "两个开关的状态" },
      { line: "/media status", note: "两个开关的状态" },
    ],
  },
  {
    id: "notify",
    command: "/notify",
    aliases: [],
    summary: "跨会话提醒推送",
    usage: "/notify on|off|status；/notify tasks on|off",
    subcommands: ["on", "off", "status", "tasks"],
    group: "pacing",
    examples: [
      { line: "/notify on", note: "开启：跨会话卡片推微信" },
      { line: "/notify off", note: "关闭" },
      { line: "/notify tasks on", note: "任务完成或报错也提醒" },
      { line: "/notify tasks off", note: "仅关任务提醒" },
      { line: "/notify", note: "两个开关的状态" },
      { line: "/notify status", note: "两个开关的状态" },
    ],
  },
  {
    id: "surface",
    command: "/surface",
    aliases: [],
    summary: "微信渠道提示词开关",
    usage: "/surface on|off|status",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/surface on", note: "开启：注入提示词" },
      { line: "/surface off", note: "关闭" },
      { line: "/surface", note: "状态；正文在设置页编辑" },
      { line: "/surface status", note: "状态；正文在设置页编辑" },
    ],
  },

  // ── 引用与回看 ───────────────────────────────────────────────────────────
  {
    id: "at",
    command: "/at",
    aliases: [],
    summary: "引用会话或文件",
    usage: "/at [s <编号|关键词> | f <路径> | rm <编号> | clear]",
    subcommands: ["s", "f", "rm", "clear"],
    group: "reference",
    examples: [
      { line: "/at", note: "查看已引用（会话 3、文件 8）" },
      { line: "/at s 2", note: "引用第 2 个会话" },
      { line: "/at s 部署", note: "按关键词查找会话" },
      { line: "/at f D:\\logs\\build.log", note: "引用文件" },
      { line: "/at f \"D:\\my docs\\spec.md\"", note: "含空格的路径加引号" },
      { line: "/at rm 1", note: "移除第 1 个引用" },
      { line: "/at clear", note: "清空全部引用" },
    ],
  },
  {
    id: "history",
    command: "/history",
    aliases: [],
    summary: "查看历史记录",
    usage: "/history [all] [数量]（默认 5，最多 20）",
    subcommands: ["all"],
    group: "reference",
    examples: [
      { line: "/history", note: "最近 5 条" },
      { line: "/history 10", note: "最近 10 条（上限 20）" },
      { line: "/history all", note: "含系统消息" },
      { line: "/history all 10", note: "系统消息 + 10 条" },
    ],
  },

  // ── 卡片 ────────────────────────────────────────────────────────────────
  {
    id: "rq",
    command: "/rq",
    aliases: [],
    summary: "关闭待处理卡片",
    usage: "/rq；其它会话的卡用 P1=/rq；/rp 只拒绝权限卡",
    subcommands: [],
    group: "card",
    examples: [
      { line: "/rq", note: "关闭当前会话全部卡片" },
      { line: "P1=/rq", note: "仅关闭第 1 张卡" },
      { line: "/rp", note: "仅拒绝权限卡" },
    ],
  },

  // ── Feishu view (`feishu-` groups) ──────────────────────────────────────
  {
    id: "feishu-help",
    command: "/help",
    aliases: [],
    summary: "查看全部命令与按钮面板",
    usage: "/help",
    subcommands: [],
    group: "feishu-basics",
    examples: [{ line: "/help", note: "命令卡片，点按钮直接执行" }],
  },
  {
    id: "feishu-status",
    command: "/status",
    aliases: [],
    summary: "查看桥接健康状态",
    usage: "/status",
    subcommands: [],
    group: "feishu-basics",
    examples: [{ line: "/status", note: "连接、队列、会话与补发" }],
  },
  {
    id: "feishu-stop",
    command: "/stop",
    aliases: [],
    summary: "中断当前会话任务",
    usage: "/stop",
    subcommands: [],
    group: "feishu-basics",
    examples: [{ line: "/stop", note: "已写入的文件不回滚" }],
  },
  {
    id: "feishu-new",
    command: "/new",
    aliases: [],
    summary: "当前工作区新起会话",
    usage: "/new",
    subcommands: [],
    group: "feishu-session",
    examples: [{ line: "/new", note: "保留工作区，上下文重开" }],
  },
  {
    id: "feishu-resume",
    command: "/resume",
    aliases: [],
    summary: "恢复当前工作区的历史会话",
    usage: "/resume | /resume <编号|会话 id>",
    subcommands: [],
    group: "feishu-session",
    examples: [
      { line: "/resume", note: "按钮选择历史会话" },
      { line: "/resume 2", note: "按卡片编号直接恢复" },
    ],
  },
  {
    id: "feishu-sessions",
    command: "/sessions",
    aliases: [],
    summary: "列出活跃会话",
    usage: "/sessions",
    subcommands: [],
    group: "feishu-session",
    examples: [{ line: "/sessions", note: "当前桥接托管的所有会话" }],
  },
  {
    id: "feishu-workspace",
    command: "/workspace",
    aliases: [],
    summary: "切换当前会话的工作区",
    usage: "/workspace <路径>；不带参数看当前工作区",
    subcommands: [],
    group: "feishu-session",
    examples: [
      { line: "/workspace ~/work/my-app", note: "支持 ~ 与相对路径" },
      { line: "/workspace /Users/me/app", note: "绝对路径最稳妥" },
    ],
  },
  {
    id: "feishu-cd",
    command: "/cd",
    aliases: [],
    summary: "切换工作区（/workspace 简写）",
    usage: "/cd <路径>",
    subcommands: [],
    group: "feishu-session",
    examples: [
      { line: "/cd ~/work/my-app", note: "解析 ~ 与相对路径" },
      { line: "/cd /Users/me/app", note: "同 /workspace 的切换" },
    ],
  },
  {
    id: "feishu-ws",
    command: "/ws",
    aliases: [],
    summary: "收藏工作区管理",
    usage: "/ws list | add <路径> | use <编号|路径> | remove <编号|路径> | status",
    subcommands: ["list", "add", "use", "remove", "status"],
    group: "feishu-session",
    examples: [
      { line: "/ws list", note: "收藏列表，点按钮即切换" },
      { line: "/ws add /Users/me/app", note: "收藏一个绝对路径" },
      { line: "/ws use 2", note: "切换到第 2 个收藏" },
      { line: "/ws remove 2", note: "删除第 2 个收藏" },
      { line: "/ws status", note: "当前与收藏概览" },
    ],
  },
  {
    id: "feishu-mode",
    command: "/mode",
    aliases: [],
    summary: "切换 Agent 模式",
    usage: "/mode",
    subcommands: [],
    group: "feishu-model",
    examples: [{ line: "/mode", note: "点按钮切换，下条生效" }],
  },
  {
    id: "feishu-permission",
    command: "/permission",
    aliases: [],
    summary: "切换权限级别",
    usage: "/permission",
    subcommands: [],
    group: "feishu-model",
    examples: [{ line: "/permission", note: "只读、工作区写、全放行" }],
  },
  {
    id: "feishu-model",
    command: "/model",
    aliases: [],
    summary: "查看或切换模型",
    usage: "/model",
    subcommands: [],
    group: "feishu-model",
    examples: [{ line: "/model", note: "按供应商点按钮切换" }],
  },
  {
    id: "feishu-lark",
    command: "/lark",
    aliases: [],
    summary: "飞书桥接管理",
    usage: "/lark setup|start|stop|restart|status|replay",
    subcommands: ["setup", "start", "stop", "restart", "status", "replay"],
    group: "feishu-ops",
    examples: [
      { line: "/lark setup", note: "扫码授权并创建应用" },
      { line: "/lark start", note: "启动长连接通道" },
      { line: "/lark stop", note: "停止长连接" },
      { line: "/lark restart", note: "重连并恢复订阅" },
      { line: "/lark status", note: "桥接整体状态" },
      { line: "/lark replay", note: "补发未投递的消息" },
    ],
  },
  {
    id: "feishu-lark-config",
    command: "/lark-config",
    aliases: [],
    summary: "热改桥接配置",
    usage: "/lark-config key=value（嵌套键用点路径）",
    subcommands: [],
    group: "feishu-ops",
    examples: [
      { line: "/lark-config streaming.enabled=true", note: "开启流式卡片" },
      { line: "/lark-config groupPolicy=mention", note: "群里需 @ 才触发" },
      { line: "/lark-config replay.auto=false", note: "关闭自动补发" },
    ],
  },
  {
    id: "feishu-doctor",
    command: "/doctor",
    aliases: [],
    summary: "生成诊断包（日志 ZIP）",
    usage: "/doctor",
    subcommands: [],
    group: "feishu-ops",
    examples: [{ line: "/doctor", note: "打包日志与会话记录" }],
  },
  {
    id: "feishu-goal",
    command: "/goal",
    aliases: [],
    summary: "长任务目标（Goal）",
    usage: "/goal <任务描述>",
    subcommands: [],
    group: "feishu-ops",
    examples: [{ line: "/goal 完成登录模块并跑通测试", note: "启动目标自驱动看板" }],
  },
];

/**
 * Which channel a group (and therefore every command in it) belongs to.
 *
 * Derived from the id instead of a per-entry field on purpose: a command can
 * never list the wrong channel because someone forgot to tag it, and adding a
 * whole section to one channel is one array insertion.
 */
export function channelOfGroup(id: HelpGroupId): HelpChannel {
  return id.startsWith("feishu-") ? "feishu" : "wechat";
}

/** Channel of a command entry — the channel of its group. */
export function channelOfEntry(entry: HelpCommandEntry): HelpChannel {
  return channelOfGroup(entry.group);
}

/**
 * The catalog for ONE channel, as a JSON-safe snapshot.
 *
 * Returned as fresh objects so a consumer (or a test) mutating its copy can
 * never change what the next request serves — the browser half, the Feishu
 * card and the WeChat `/help` text are views of the same install.
 */
export function catalogFor(channel: HelpChannel): HelpCatalog {
  const groups = GROUPS.filter((group) => channelOfGroup(group.id) === channel).map(
    (group) => ({ ...group }),
  );
  const groupIds = new Set(groups.map((group) => group.id));
  return {
    intro: INTROS[channel],
    footer: FOOTERS[channel],
    groups,
    commands: COMMANDS.filter((entry) => groupIds.has(entry.group)).map((entry) => ({
      ...entry,
      aliases: [...entry.aliases],
      subcommands: [...entry.subcommands],
      examples: entry.examples.map((example) => ({ ...example })),
    })),
  };
}

/**
 * The WECHAT view — the name every existing consumer (the `/wechat/api/help`
 * route, the settings panel, `bridge/slash.ts`) already imports.
 */
export function helpCatalog(): HelpCatalog {
  return catalogFor("wechat");
}

/** The FEISHU view — used by `/help`'s button card and the console cheat sheet. */
export function feishuHelpCatalog(): HelpCatalog {
  return catalogFor("feishu");
}

/**
 * The shortest spelling of a command: the command name itself or its shortest
 * alias, with the leading slash. `/session` → `/s`, `/perm` → `/perm`.
 *
 * WeChat's `/help` uses this for BOTH the command head and every subcommand it
 * lists (`/s list`, `/md at`), so a reader never sees a long spelling where a
 * short one exists.
 */
export function shortestSpelling(entry: HelpCommandEntry): string {
  const names = [entry.command.replace(/^\//, ""), ...entry.aliases];
  const shortest = names.reduce((best, name) => (name.length < best.length ? name : best));
  return `/${shortest}`;
}

/** Look up one entry by any spelling it accepts, case-insensitively. */
function findIn(
  entries: readonly HelpCommandEntry[],
  topic: string,
): HelpCommandEntry | undefined {
  const needle = topic.trim().replace(/^\//, "").toLowerCase();
  if (!needle) return undefined;
  return entries.find((entry) => {
    if (entry.command.replace(/^\//, "").toLowerCase() === needle) return true;
    return entry.aliases.some((alias) => alias.toLowerCase() === needle);
  });
}

/**
 * Find a WECHAT catalog entry by any spelling it accepts, case-insensitively.
 *
 * Used by WeChat's `/help <topic>`: the user may type `/help session`,
 * `/help s`, or `/help SESSION`. Returns `undefined` for an unknown topic so
 * the caller can fall back to the listing instead of inventing an answer.
 */
export function findHelpEntry(topic: string): HelpCommandEntry | undefined {
  return findIn(helpCatalog().commands, topic);
}

/** Feishu counterpart of {@link findHelpEntry}. */
export function findFeishuHelpEntry(topic: string): HelpCommandEntry | undefined {
  return findIn(feishuHelpCatalog().commands, topic);
}

