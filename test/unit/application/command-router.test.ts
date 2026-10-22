import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRouter, type DshCommandRegistry } from "../../../src/application/command-router.ts";
import { createBridgeContext } from "../../../src/application/bridge-context.ts";
import { createStatusStore } from "../../../src/common/connection-status.ts";
import { createLogger } from "../../../src/common/logger.ts";
import { DEFAULT_CONFIG } from "../../../src/common/config.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (text: string, messageId = "m1"): FeishuInboundMessage => ({
  messageId,
  chatId: "ou_x",
  chatType: "p2p",
  chatMode: "p2p",
  senderOpenId: "ou_u",
  msgType: "text",
  content: text,
  text,
  mentions: [],
  timestamp: Date.now(),
});

function makeRouter(overrides: { dshHas?: string[]; bridgeHandler?: (name: string) => Promise<boolean> } = {}) {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
    // Tier 2 needs a resolvable agent (agentId) — mock the backend lookup.
    backend: {
      get: () => ({ agentId: "agent-1" }),
    } as never,
  });
  const dshCommands: DshCommandRegistry = {
    has: (name) => (overrides.dshHas ?? ["compact"]).includes(name),
    async run(name, rawInput) {
      return { kind: "success", text: `dsh:${name}:${rawInput}` };
    },
  };
  const router = createCommandRouter({
    ctx,
    commands: dshCommands,
    bridgeHandler: async (name) => {
      if (overrides.bridgeHandler) return overrides.bridgeHandler(name);
      return ["status", "support", "lark-config", "help", "workspace", "stop"].includes(name);
    },
  });
  return { router, ctx };
}

test("router: plain text routes to agent", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("hello")), "agent");
});

test("router: bridge commands are consumed by the bridge", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("/status")), "bridge");
  assert.equal(await router.route(mkMsg("/support")), "bridge");
});

test("router: DSH-registered commands run natively and reply via outbox", async () => {
  const { router } = makeRouter({ dshHas: ["compact"] });
  assert.equal(await router.route(mkMsg("/compact old")), "dsh");
});

test("router: unknown /xxx passes through to the agent (三级分流 tier 3)", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("/goal 写周报")), "agent");
  assert.equal(await router.route(mkMsg("/skill:review")), "agent");
});

test("router: bridge handler decline falls through to agent", async () => {
  const { router } = makeRouter({ bridgeHandler: async () => false });
  assert.equal(await router.route(mkMsg("/status")), "agent");
});

test("router: empty text is skipped", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("")), "skipped");
});

test("router: /resume is a Tier-1 bridge command (handled before DSH tier)", async () => {
  // DSH ALSO registers a /resume command (tier 2) — the Feishu-side picker
  // must win first, exactly like /permission.
  const seen: string[] = [];
  const { router } = makeRouter({
    dshHas: ["resume"],
    bridgeHandler: async (name) => {
      seen.push(name);
      return name === "resume";
    },
  });
  assert.equal(await router.route(mkMsg("/resume")), "bridge");
  assert.equal(await router.route(mkMsg("/resume 2")), "bridge");
  assert.deepEqual(seen, ["resume", "resume"]);
});

test("router: commands with leading @mentions in group chats route correctly", async () => {
  const seen: string[] = [];
  const { router } = makeRouter({
    dshHas: ["compact"],
    bridgeHandler: async (name) => {
      seen.push(name);
      return ["status", "help"].includes(name);
    },
  });
  // Feishu placeholder mention: @_user_1 /status
  assert.equal(await router.route(mkMsg("@_user_1 /status")), "bridge");
  // Bot name mention: @小斯 /help
  assert.equal(await router.route(mkMsg("@小斯 /help")), "bridge");
  // XML at-tag: <at user_id="ou_xxx">@bot</at> /status
  assert.equal(await router.route(mkMsg('<at user_id="ou_xxx">@bot</at> /status')), "bridge");
  // DSH command with mention: @_user_1 /compact old
  assert.equal(await router.route(mkMsg("@_user_1 /compact old")), "dsh");
  // Plain text with mention: @_user_1 你好 -> agent
  assert.equal(await router.route(mkMsg("@_user_1 你好")), "agent");
  assert.deepEqual(seen, ["status", "help", "status"]);
});

// ---- workspace ergonomics: /cd + /ws --------------------------------------
//
// /cd is a pure alias of the existing /workspace handler (forwarded verbatim,
// so relative-path resolution + the per-conversation override stay in ONE
// place). /ws owns the saved-workspace store and delegates the actual switch
// to that same handler. `/ws list` replies with a card whose buttons carry the
// EXISTING `workspace:<path>` op — the card-action path already dispatches it.

interface CapturedEnvelope {
  dedupeKey: string;
  laneKey: string;
  route: { sessionKey: string; chatId: string; chatType: string };
  kind: string;
  payload:
    | { kind: "text"; text: string }
    | { kind: "card"; card: Record<string, unknown>; text?: string };
}

function collectButtons(node: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.tag === "button") acc.push(obj);
    for (const value of Object.values(obj)) collectButtons(value, acc);
  }
  return acc;
}

function buttonValueOf(node: unknown): Record<string, unknown> {
  const behaviors = (node as { behaviors?: Array<{ type?: string; value?: Record<string, unknown> }> })
    ?.behaviors;
  return behaviors?.[0]?.value ?? {};
}

async function makeWorkspaceRouter(opts: { root: string; workspacesFile: string }) {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => ({ ...DEFAULT_CONFIG, workspaceRoot: opts.root }),
    status: createStatusStore(undefined),
    backend: { get: () => ({ agentId: "agent-1" }) } as never,
  });
  const envelopes: CapturedEnvelope[] = [];
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  ctx.setOutbox({
    async enqueue(input: CapturedEnvelope) {
      envelopes.push(input);
      return "id";
    },
  } as never);
  const calls: Array<{ name: string; arg: string }> = [];
  const router = createCommandRouter({
    ctx,
    commands: {
      has: () => false,
      async run() {
        return { kind: "success", text: "" };
      },
    },
    bridgeHandler: async (name, arg) => {
      calls.push({ name, arg });
      return name === "workspace";
    },
    workspacesFile: opts.workspacesFile,
    workspaceRootFor: (key) =>
      key === "dm:ou_x" ? opts.root : undefined,
    now: () => 1_000,
  });
  const outbox = {
    reactions,
    // The router only records reactions through ctx.sender; a sender stub is
    // not installed here, so markDone is a no-op — fine for routing asserts.
  };
  return { router, envelopes, calls, outbox };
}

function lastText(envelopes: CapturedEnvelope[]): string {
  const payload = envelopes[envelopes.length - 1]?.payload;
  return payload?.kind === "text" ? payload.text : "";
}

function lastCard(envelopes: CapturedEnvelope[]): Record<string, unknown> | undefined {
  const payload = envelopes[envelopes.length - 1]?.payload;
  return payload?.kind === "card" ? payload.card : undefined;
}

test("router: /cd forwards the raw argument to the /workspace handler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-cd-"));
  try {
    const { router, calls } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    assert.equal(await router.route(mkMsg("/cd ~/work")), "bridge");
    assert.deepEqual(calls, [{ name: "workspace", arg: "~/work" }]);
    // Bare /cd = "show current workspace" (the workspace handler's no-arg form).
    assert.equal(await router.route(mkMsg("/cd")), "bridge");
    assert.deepEqual(calls[1], { name: "workspace", arg: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /cd falls through to the agent when the workspace handler declines", async () => {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
  });
  const router = createCommandRouter({
    ctx,
    commands: { has: () => false, async run() { return { kind: "success", text: "" }; } },
    bridgeHandler: async () => false,
    workspacesFile: join(tmpdir(), `lark-cd-decline-${process.pid}.json`),
  });
  assert.equal(await router.route(mkMsg("/cd /tmp")), "agent");
});

test("router: /ws list replies with a button card using the existing workspace op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-"));
  const projectA = join(dir, "app-a");
  const projectB = join(dir, "app b"); // space in the path must survive the op
  try {
    mkdirSync(projectA);
    mkdirSync(projectB);
    const { router, envelopes } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    assert.equal(await router.route(mkMsg("/ws add " + projectA)), "bridge");
    assert.match(lastText(envelopes), /已收藏工作区:/);
    assert.equal(await router.route(mkMsg("/ws add " + projectB)), "bridge");
    // Duplicate add is reported, not appended.
    assert.equal(await router.route(mkMsg("/ws add " + projectA)), "bridge");
    assert.match(lastText(envelopes), /已在收藏中:/);

    assert.equal(await router.route(mkMsg("/ws list", "m-list")), "bridge");
    const card = lastCard(envelopes);
    assert.ok(card, "list must reply with a card");
    // A plain-text fallback rides along with the card so a host whose card
    // delivery fails can still answer (see the index.ts outbox sender).
    const listPayload = envelopes[envelopes.length - 1]?.payload;
    assert.ok(listPayload && listPayload.kind === "card" && typeof listPayload.text === "string");
    assert.match(listPayload.text, /收藏工作区/);
    assert.equal(card.schema, "2.0");
    const buttons = collectButtons(card);
    assert.equal(buttons.length, 2);
    const values = buttons.map(buttonValueOf);
    assert.deepEqual(
      values.map((value) => value.op),
      [`workspace:${projectA}`, `workspace:${projectB}`],
    );
    // The card-action dispatcher splits op at the FIRST ":" — the path must
    // survive intact (Windows drive letters and spaces included).
    for (const [index, value] of values.entries()) {
      const op = String(value.op);
      const sep = op.indexOf(":");
      assert.equal(op.slice(0, sep), "workspace");
      assert.equal(op.slice(sep + 1), index === 0 ? projectA : projectB);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /ws use <number> delegates the saved absolute path to /workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-use-"));
  const project = join(dir, "proj");
  try {
    mkdirSync(project);
    const { router, calls } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    await router.route(mkMsg("/ws add " + project));
    assert.equal(await router.route(mkMsg("/ws use 1")), "bridge");
    assert.deepEqual(calls[calls.length - 1], { name: "workspace", arg: project });
    // `switch` is an accepted synonym, and an unsaved existing path is usable.
    assert.equal(await router.route(mkMsg("/ws switch 1")), "bridge");
    assert.deepEqual(calls[calls.length - 1], { name: "workspace", arg: project });
    assert.equal(await router.route(mkMsg("/ws " + project)), "bridge");
    assert.deepEqual(calls[calls.length - 1], { name: "workspace", arg: project });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /ws use reports an unknown saved reference instead of switching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-miss-"));
  try {
    const { router, envelopes, calls } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    assert.equal(await router.route(mkMsg("/ws use 9")), "bridge");
    assert.match(lastText(envelopes), /未找到收藏工作区/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /ws remove deletes the saved entry (by number and by path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-rm-"));
  const projectA = join(dir, "a");
  const projectB = join(dir, "b");
  const file = join(dir, "workspaces.json");
  try {
    mkdirSync(projectA);
    mkdirSync(projectB);
    const { router, envelopes } = await makeWorkspaceRouter({ root: dir, workspacesFile: file });
    await router.route(mkMsg("/ws add " + projectA));
    await router.route(mkMsg("/ws add " + projectB));
    assert.equal(await router.route(mkMsg("/ws remove 1")), "bridge");
    assert.match(lastText(envelopes), /已删除收藏工作区:/);
    assert.equal(await router.route(mkMsg("/ws remove " + projectB)), "bridge");
    assert.match(lastText(envelopes), /列表已空/);
    assert.equal(await router.route(mkMsg("/ws remove 1")), "bridge");
    assert.match(lastText(envelopes), /未找到收藏工作区/);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { workspaces: unknown[] };
    assert.deepEqual(persisted.workspaces, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /ws add validates the directory and never switches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-add-"));
  try {
    const { router, envelopes, calls } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    assert.equal(await router.route(mkMsg("/ws add " + join(dir, "missing"))), "bridge");
    assert.match(lastText(envelopes), /目录不存在:/);
    assert.equal(calls.length, 0, "add must not switch the conversation");
    assert.equal(await router.route(mkMsg("/ws add")), "bridge");
    assert.match(lastText(envelopes), /用法：\/ws list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: /ws status reports the current workspace and the saved list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-status-"));
  const project = join(dir, "proj");
  try {
    mkdirSync(project);
    const { router, envelopes } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    await router.route(mkMsg("/ws add " + project));
    assert.equal(await router.route(mkMsg("/ws status")), "bridge");
    const text = lastText(envelopes);
    assert.match(text, /当前:/);
    assert.match(text, /收藏: 1 个/);
    assert.match(text, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: unknown /ws subcommands answer with usage (never forwarded to the agent)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-usage-"));
  try {
    const { router, envelopes } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: join(dir, "workspaces.json"),
    });
    assert.equal(await router.route(mkMsg("/ws wat")), "bridge");
    assert.match(lastText(envelopes), /用法：\/ws list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: handleWorkspace consumes card-action ops (ws:list, ws:use:1, ws:remove:1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-ws-card-"));
  const project = join(dir, "proj");
  const file = join(dir, "workspaces.json");
  try {
    mkdirSync(project);
    const { router, envelopes, calls } = await makeWorkspaceRouter({
      root: dir,
      workspacesFile: file,
    });
    // The host splits `ws:add:<path>` at the FIRST colon; the path (with its
    // own colons/spaces on Windows) arrives intact as `add:<path>`.
    assert.equal(await router.handleWorkspace(`add:${project}`, mkMsg("card1")), true);
    assert.equal(await router.handleWorkspace("list", mkMsg("card2")), true);
    const card = lastCard(envelopes);
    assert.ok(card);
    assert.equal(collectButtons(card).length, 1);
    assert.equal(await router.handleWorkspace("use:1", mkMsg("card3")), true);
    assert.deepEqual(calls[calls.length - 1], { name: "workspace", arg: project });
    assert.equal(await router.handleWorkspace("remove:1", mkMsg("card4")), true);
    assert.match(lastText(envelopes), /已删除收藏工作区/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
