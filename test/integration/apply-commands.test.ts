// Integration: fake Cordis ctx + REAL apply() drives the Feishu command /
// message pipeline and asserts what the bridge actually sends to Feishu.
//
// See test/integration/apply-harness.ts for how the harness is built: the only
// production dependency replaced is the Feishu SDK (module hook); apply(),
// transport, command router, outbox, cards, forwarder and cardkit stream are
// all the real code paths.
//
// Scenario map (BUG audit A):
//   1. /model picker card, listConfigurableProviders fallback, empty-catalog diag
//   2. /help classic card content (all commands, no buttons)
//   3. /status durable TEXT reply (not a run/model card)
//   4. /new workspace == most recently updated DSH workspace store entry
//   5. /cd and /ws list|add|use|remove (+ persistence)
//   6. /mode, /permission, /model switch via text AND card-action buttons
//   7. plain message: runCard OFF → durable text reply, no cardkit; ON → run card
//   8. wechat.enabled="0" never reaches applyWechatChannel (flagOff)
//   +  DSH-side /lark command handler captured through ctx.commands.register()

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	cardButtons,
	cardText,
	createApplyHarness,
	readJsonFile,
	waitFor,
	writeWorkspaceStore,
	type ApplyHarness,
	type ApplyHarnessOptions,
} from "./apply-harness.ts";

const CHAT = "ou_audit_user";

/** Boot a fresh plugin instance and always tear it down. */
async function withHarness(
	opts: ApplyHarnessOptions,
	fn: (h: ApplyHarness) => Promise<void>,
): Promise<void> {
	const h = await createApplyHarness(opts);
	try {
		// The lifecycle effect calls startBridge() (void); wait for the captured
		// transport to register its event handlers = bridge is up.
		await h.waitFor(() => h.fake.dispatchers[0]?.handlers["im.message.receive_v1"], {
			label: "bridge transport started",
		});
		await fn(h);
	} finally {
		await h.teardown();
	}
}

const textContains = (h: ApplyHarness, needle: string) =>
	waitFor(
		() => h.textBodies().find((text) => text.includes(needle)),
		{ label: `text reply containing ${needle}` },
	);

const cardWhere = (h: ApplyHarness, needle: string) =>
	waitFor(
		() => {
			const cards = h.cardPayloads();
			return cards.find((card) => cardText(card).includes(needle));
		},
		{ label: `card containing ${needle}` },
	);

/** Outbox envelope payloads of one kind (command-reply / assistant-output). */
function outboxPayloads(h: ApplyHarness, kind: string): Array<Record<string, unknown>> {
	return h.outboxEnvelopes()
		.filter((env) => env.kind === kind)
		.map((env) => env.payload as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 0. The captured DSH command (/lark dispatcher registered via ctx.commands)
// ---------------------------------------------------------------------------

test("apply: /lark command handler is captured and answers status/usage/replay", async () => {
	await withHarness({}, async (h) => {
		// exactly one DSH command, with an input hint (needed by the GUI composer)
		assert.deepEqual(
			h.commands.map((c) => c.name),
			["lark"],
			"one /lark dispatcher command",
		);
		assert.ok(h.commands[0]?.input?.hint, "/lark has an input hint");
		// tools still register (lark_send_local_file / lark_config_get)
		assert.deepEqual(
			h.tools.map((t) => t.name).sort(),
			["lark_config_get", "lark_send_local_file"],
		);

		const status = await h.runDshCommand("lark", "status");
		assert.equal(status.kind, "success");
		assert.match(String(status.text), /连接: CONNECTED/);

		const usage = await h.runDshCommand("lark");
		assert.match(String(usage.text), /Lark Link 用法：\/lark setup/);

		const replay = await h.runDshCommand("lark", "replay list");
		assert.match(String(replay.text), /WAL 为空/);
	});
});

// ---------------------------------------------------------------------------
// 1. /model
// ---------------------------------------------------------------------------

test("/model: picker card buttons carry model:<provider>/<model>", async () => {
	await withHarness(
		{
			defaultModel: { provider: "p0", model: "m0" },
			llm: {
				listProviders: () => [{ id: "p1", name: "P1" }],
				listModels: async (provider) =>
					provider === "p1"
						? [
								{ id: "m1", name: "M1" },
								{ id: "m2", name: "M2" },
							]
						: [],
			},
		},
		async (h) => {
			h.sendInbound("/model", { chatId: CHAT });
			const card = await cardWhere(h, "当前模型");
			assert.ok(cardText(card).includes("p0/m0"), "shows current model");
			const ops = cardButtons(card).map((b) => b.op);
			assert.deepEqual(ops, ["model:p1/m1", "model:p1/m2"]);
		},
	);
});

test("/model: empty listProviders falls back to listConfigurableProviders", async () => {
	await withHarness(
		{
			llm: {
				listProviders: () => [],
				listConfigurableProviders: () => [
					{ provider: "p2", displayName: "P2 目录" },
				],
				listModels: async (provider) =>
					provider === "p2" ? [{ id: "m2", name: "M2" }] : [],
			},
		},
		async (h) => {
			h.sendInbound("/model", { chatId: CHAT });
			const card = await cardWhere(h, "P2 目录");
			assert.deepEqual(
				cardButtons(card).map((b) => b.op),
				["model:p2/m2"],
				"fallback provider id/name mapping (host type: provider/displayName)",
			);
		},
	);
});

test("/model: empty catalog replies a diagnosable TEXT message (no blank card)", async () => {
	await withHarness(
		{
			llm: {
				listProviders: () => [],
				listConfigurableProviders: () => [],
				listModels: async () => [],
			},
		},
		async (h) => {
			h.sendInbound("/model", { chatId: CHAT });
			const text = await textContains(h, "未获取到可选模型列表");
			assert.match(text, /llm=true/);
			assert.match(text, /providers=0/);
			assert.match(text, /\/model <provider>\/<model>/);
			// durable command-reply payload is TEXT (not a card)
			const payloads = outboxPayloads(h, "command-reply");
			assert.ok(
				payloads.some((p) => String(p.text ?? "").includes("未获取到可选模型列表")),
				"diagnostic went through the durable text lane",
			);
			assert.equal(
				h.cardPayloads().filter((c) => cardText(c).includes("按供应商选择模型")).length,
				0,
				"no blank picker card",
			);
		},
	);
});

// ---------------------------------------------------------------------------
// 2. /help
// ---------------------------------------------------------------------------

test("/help: classic help card lists every command and has no buttons", async () => {
	await withHarness({}, async (h) => {
		h.sendInbound("/help", { chatId: CHAT });
		const card = await cardWhere(h, "可用命令");
		const text = cardText(card);
		for (const command of [
			"/status",
			"/mode",
			"/permission",
			"/new",
			"/resume",
			"/workspace",
			"/cd",
			"/ws",
			"/stop",
			"/doctor",
			"/model",
			"/lark-config",
			"/lark",
		]) {
			assert.ok(text.includes(command), `/help mentions ${command}`);
		}
		assert.equal(cardButtons(card).length, 0, "no buttons on /help");
		// durable command-reply payload is a card (help stays a card per docs)
		const payloads = outboxPayloads(h, "command-reply");
		assert.ok(
			payloads.some((p) => p.kind === "card"),
			"help was queued as a card payload",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. /status
// ---------------------------------------------------------------------------

test("/status: durable TEXT reply (classic status, not a run/model card)", async () => {
	await withHarness({}, async (h) => {
		h.sendInbound("/status", { chatId: CHAT });
		// The durable payload is TEXT (the source of truth for this command).
		// NB: on the wire the sender's looksLikeMarkdown() heuristic wraps any
		// body containing a blank line in a markdown card — that is the
		// pre-existing behaviour on main (same durableReply → sendText path),
		// so this test asserts the payload kind, not the delivered msg_type.
		const payload = await h.waitFor(
			() =>
				outboxPayloads(h, "command-reply").find((p) =>
					String(p.text ?? "").includes("状态: connected"),
				),
			{ label: "durable status reply" },
		);
		assert.equal(payload.kind, "text", "payload kind is text — not a card");
		assert.match(String(payload.text), /连接: CONNECTED/);
		assert.match(String(payload.text), /outbox 待发:/);

		// wire-level: a plain markdown card with no buttons (never a run card)
		const card = await cardWhere(h, "状态: connected");
		assert.deepEqual(cardButtons(card), [], "status has no buttons");
		assert.match(cardText(card), /连接: CONNECTED/);

		// no cardkit traffic is generated by /status
		assert.equal(
			h.fake.requests.filter((r) => r.url.includes("/cardkit/")).length,
			0,
			"no CardKit request for /status",
		);
	});
});

// ---------------------------------------------------------------------------
// 4. /new — workspace == most recently updated workspace in the DSH store
// ---------------------------------------------------------------------------

test("/new: reply workspace is the most recently updated DSH workspace", async () => {
	let expectRecent = "";
	let expectOld = "";
	await withHarness(
		{
			prepare(dirs) {
				expectOld = join(dirs.root, "ws-old");
				expectRecent = join(dirs.root, "ws-recent");
				mkdirSync(expectOld, { recursive: true });
				mkdirSync(expectRecent, { recursive: true });
				writeWorkspaceStore(dirs.dshHome, {
					global: { defaultWorkspaceId: "w_old" },
					tables: {
						workspaces: {
							w_old: {
								path: expectOld,
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
							w_recent: {
								path: expectRecent,
								updatedAt: "2026-06-01T00:00:00.000Z",
							},
						},
					},
				});
			},
		},
		async (h) => {
			h.sendInbound("/new", { chatId: CHAT });
			const text = await textContains(h, "已开启新会话");
			assert.ok(
				text.includes(expectRecent),
				`workspace should be the recently updated one (${expectRecent}), got: ${text}`,
			);
			assert.ok(!text.includes(expectOld), "not the stale/default workspace");
		},
	);
});

// ---------------------------------------------------------------------------
// 5. /cd and /ws
// ---------------------------------------------------------------------------

test("/cd + /ws list|add|use|remove: replies and durable persistence", async () => {
	await withHarness(
		{
			prepare(dirs) {
				mkdirSync(join(dirs.root, "ws-a"), { recursive: true });
				mkdirSync(join(dirs.root, "ws-b"), { recursive: true });
				mkdirSync(join(dirs.root, "ws-b", "nested"), { recursive: true });
			},
		},
		async (h) => {
			const wsA = join(h.dirs.root, "ws-a");
			const wsB = join(h.dirs.root, "ws-b");
			const overridesFile = join(h.dirs.stateDir, "conversation-overrides.json");
			const workspacesFile = join(h.dirs.dshHome, "lark-link", "workspaces.json");
			const key = `dm:${CHAT}`;

			// /cd <absolute>
			h.sendInbound(`/cd ${wsA}`, { chatId: CHAT });
			await textContains(h, `工作区已切换: ${wsA}`);
			await h.waitFor(
				() =>
					(readJsonFile(overridesFile) as Record<string, { workspaceRoot?: string }>)?.[
						key
					]?.workspaceRoot === wsA,
				{ label: "convCfg workspace persisted" },
			);

			// /cd <relative> resolves against the current workspace (ws-a)
			h.sendInbound("/cd ../ws-b", { chatId: CHAT });
			await textContains(h, `工作区已切换: ${wsB}`);

			// /ws add
			h.sendInbound(`/ws add ${wsA}`, { chatId: CHAT });
			await textContains(h, `已收藏工作区: ${wsA}`);
			await h.waitFor(
				() =>
					(
						readJsonFile(workspacesFile) as {
							workspaces?: Array<{ path: string }>;
						}
					)?.workspaces?.some((entry) => entry.path === wsA),
				{ label: "workspaces.json persisted" },
			);

			// /ws list → button card with workspace:<path> ops
			h.sendInbound("/ws list", { chatId: CHAT });
			const listCard = await cardWhere(h, "收藏工作区");
			const listOps = cardButtons(listCard).map((b) => b.op);
			assert.deepEqual(listOps, [`workspace:${wsA}`]);

			// clicking the card button reuses the existing workspace:<path> op
			h.sendCardAction(`workspace:${wsA}`, { chatId: CHAT });
			await textContains(h, `工作区已切换: ${wsA}`);

			// /ws use 1 → delegates to the /workspace switch
			h.sendInbound("/ws use 1", { chatId: CHAT });
			await textContains(h, `工作区已切换: ${wsA}`);

			// /ws remove 1
			h.sendInbound("/ws remove 1", { chatId: CHAT });
			await textContains(h, "已删除收藏工作区: " + wsA);
			await h.waitFor(
				() =>
					(
						readJsonFile(workspacesFile) as {
							workspaces?: Array<{ path: string }>;
						}
					)?.workspaces?.length === 0,
				{ label: "saved workspace removed" },
			);

			// relative /cd survived: "../ws-b/nested" from the current (ws-a)
			h.sendInbound("/cd ../ws-b/nested", { chatId: CHAT });
			await textContains(h, `工作区已切换: ${join(wsB, "nested")}`);
		},
	);
});

// ---------------------------------------------------------------------------
// 6. /mode /permission /model switches (text + card-action buttons)
// ---------------------------------------------------------------------------

test("/mode: picker card + card-action switch persists the per-chat preset", async () => {
	await withHarness({}, async (h) => {
		const overridesFile = join(h.dirs.stateDir, "conversation-overrides.json");
		const key = `dm:${CHAT}`;
		const modeCards = () =>
			h.cardPayloads().filter((card) => cardText(card).includes("Agent 模式"));

		h.sendInbound("/mode", { chatId: CHAT });
		const card = await cardWhere(h, "Agent 模式");
		const modeOps = cardButtons(card).map((b) => b.op);
		assert.deepEqual(modeOps, ["mode:standard", "mode:ptc", "mode:minimal"]);
		assert.ok(
			cardText(card).includes("PTC 模式 ← 当前"),
			"bridge default (ptc) marked current before any switch",
		);

		// click the button — the real card.action.trigger path (pseudo message)
		h.sendCardAction("mode:standard", { chatId: CHAT });
		await textContains(h, "模式已切换为 标准模式");
		await h.waitFor(
			() =>
				(readJsonFile(overridesFile) as Record<string, { preset?: string }>)?.[key]
					?.preset === "standard",
			{ label: "convCfg preset persisted" },
		);

		// Reopen the picker: the CURRENT marker must follow the per-chat
		// override, not the bridge default (regression: showed PTC again).
		h.sendInbound("/mode", { chatId: CHAT });
		const cards = await h.waitFor(
			() => {
				const opened = modeCards();
				return opened.length >= 2 ? opened : undefined;
			},
			{ label: "second /mode picker card" },
		);
		const latest = cardText(cards[cards.length - 1]);
		assert.ok(
			latest.includes("标准模式 ← 当前"),
			`picker must mark the switched preset as current, got:\n${latest}`,
		);
		assert.ok(
			!latest.includes("PTC 模式 ← 当前"),
			"stale bridge default must not be marked current",
		);
	});
});

// Regression (BUG audit A#3): durableReply dedupes command replies by
// `bridge:<cmd>:<messageId>`, and the card message id is STABLE across clicks.
// Keying the pseudo message id on `${messageId}#${op}` therefore swallowed a
// second click on the SAME button (the switch ran, the user got no receipt).
// The host now appends a monotonic per-click sequence — both clicks must reply.
test("/mode: clicking the SAME card button twice yields two command replies", async () => {
	await withHarness({}, async (h) => {
		h.sendInbound("/mode", { chatId: CHAT });
		await cardWhere(h, "Agent 模式");

		const modeReplies = () =>
			outboxPayloads(h, "command-reply").filter((payload) =>
				String(payload.text ?? "").includes("模式已切换为 标准模式"),
			);

		// Same card message id + same op, twice.
		h.sendCardAction("mode:standard", { chatId: CHAT, messageId: "om_mode_card_1" });
		await h.waitFor(() => modeReplies().length >= 1, { label: "first click reply" });
		h.sendCardAction("mode:standard", { chatId: CHAT, messageId: "om_mode_card_1" });
		await h.waitFor(() => modeReplies().length >= 2, {
			label: "second click on the same button must also reply",
		});
		assert.equal(
			modeReplies().length,
			2,
			"both clicks produced a durable command-reply envelope",
		);
		// ...and both were actually delivered to the chat (outbox drain is async).
		const delivered = () =>
			h.textBodies().filter((text) => text.includes("模式已切换为 标准模式"));
		await h.waitFor(() => delivered().length >= 2, {
			label: "both receipts delivered to Feishu",
		});
		assert.equal(delivered().length, 2, "both receipts were delivered to Feishu");
	});
});

test("/permission: picker card + switch applies live session and persists", async () => {
	await withHarness({}, async (h) => {
		const overridesFile = join(h.dirs.stateDir, "runtime-overrides.json");
		// create a live bridge session first so the switch has an agent/session
		h.sendInbound("hi", { chatId: CHAT });
		await h.waitForAgent();

		h.sendInbound("/permission", { chatId: CHAT });
		const card = await cardWhere(h, "权限模式");
		const ops = cardButtons(card).map((b) => b.op);
		assert.deepEqual(ops, [
			"permission:read-only",
			"permission:workspace-write",
			"permission:danger-full-access",
		]);

		h.sendInbound("/permission workspace-write", { chatId: CHAT });
		await textContains(h, "权限已切换为 workspace-write（仅桥接会话生效）");
		const overrides = readJsonFile(overridesFile) as { permissionMode?: string };
		assert.equal(overrides?.permissionMode, "workspace-write");
		// the live session's permission preset was applied through
		// ctx.get("permissionPresets").apply (session-scoped, GH #8)
		assert.ok(
			h.state.permissionApplies.some((entry) => entry.preset === "workspace-write"),
			"permissionPresets.apply called for the live session",
		);
	});
});

test("/model <provider>/<model>: switch receipt + per-chat persistence", async () => {
	await withHarness(
		{
			llm: {
				listProviders: () => [{ id: "p1", name: "P1" }],
				listModels: async () => [{ id: "m1", name: "M1" }],
			},
		},
		async (h) => {
			const overridesFile = join(h.dirs.stateDir, "conversation-overrides.json");
			const key = `dm:${CHAT}`;
			h.sendInbound("/model p1/m1", { chatId: CHAT });
			await textContains(h, "模型已切换: p1/m1");
			await h.waitFor(
				() =>
					(readJsonFile(overridesFile) as Record<string, { provider?: string; model?: string }>)?.[
						key
					]?.model === "m1",
				{ label: "convCfg model persisted" },
			);
		},
	);
});

test("/model: clicking a picker button switches via the card-action path", async () => {
	await withHarness(
		{
			llm: {
				listProviders: () => [{ id: "p1", name: "P1" }],
				listModels: async () => [{ id: "m1", name: "M1" }],
			},
		},
		async (h) => {
			h.sendInbound("/model", { chatId: CHAT });
			const card = await cardWhere(h, "当前模型");
			assert.deepEqual(
				cardButtons(card).map((b) => b.op),
				["model:p1/m1"],
			);
			h.sendCardAction("model:p1/m1", { chatId: CHAT });
			await textContains(h, "模型已切换: p1/m1");
		},
	);
});

// ---------------------------------------------------------------------------
// 7. plain message: runCard OFF (text/outbox) vs ON (whole-card stream)
// ---------------------------------------------------------------------------

test("plain message: runCard OFF delivers a durable TEXT reply (no CardKit)", async () => {
	await withHarness({}, async (h) => {
		const msgId = h.sendInbound("你好呀", { chatId: CHAT });
		const agent = await h.waitForAgent();
		await h.waitFor(() => agent.followups.length >= 1, { label: "followup dispatched" });

		// drive the real normalized session-event pipeline
		h.emitSessionEvent({ type: "turn/start" });
		h.emitSessionEvent({
			type: "assistant/message",
			data: { message: { id: "msg_1", content: [{ type: "text", text: "普通回复内容" }] } },
		});
		h.emitSessionEvent({ type: "turn/end", data: { reason: { kind: "done" } } });

		const text = await textContains(h, "普通回复内容");
		assert.ok(text.length > 0);
		// durable assistant-output payload is text
		const payloads = outboxPayloads(h, "assistant-output");
		assert.ok(
			payloads.some((p) => p.kind === "text" && String(p.text).includes("普通回复内容")),
			"assistant text went through the durable outbox",
		);
		// DONE reaction on the triggering message
		await h.waitFor(
			() =>
				h.fake.reactions.some(
					(r) => r.message_id === msgId && r.emoji_type === "DONE",
				),
			{ label: "DONE reaction" },
		);
		// runCard OFF ⇒ no CardKit entity at all
		assert.equal(
			h.fake.requests.filter((r) => r.url.includes("/cardkit/")).length,
			0,
			"no CardKit traffic when streaming.runCard is off",
		);
	});
});

test("plain message: streaming.runCard=true drives the whole-card CardKit stream", async () => {
	await withHarness({}, async (h) => {
		// hot-enable run cards through the real command path
		h.sendInbound("/lark-config streaming.runCard=true", { chatId: CHAT });
		await textContains(h, "已更新 streaming.runCard=true");

		h.sendInbound("第二轮", { chatId: CHAT });
		const agent = await h.waitForAgent();
		await h.waitFor(() => agent.followups.length >= 1, { label: "followup dispatched" });

		h.emitSessionEvent({ type: "turn/start" });
		h.emitSessionEvent({
			type: "assistant/chunk",
			data: { chunk: { type: "text-delta", text: "卡片回复" } },
		});
		h.emitSessionEvent({
			type: "assistant/message",
			data: { message: { id: "msg_2", content: [{ type: "text", text: "卡片回复内容" }] } },
		});
		h.emitSessionEvent({
			type: "tool/call",
			data: { callId: "call_1", name: "bash", arguments: '{"command":"ls"}' },
		});
		h.emitSessionEvent({
			type: "tool/result",
			data: { callId: "call_1", message: { content: [{ type: "text", text: "ok" }] } },
		});
		h.emitSessionEvent({ type: "turn/end", data: { reason: { kind: "done" } } });

		// card entity created + delivered, then finalized through PUT
		await h.waitFor(
			() =>
				h.fake.requests.some(
					(r) =>
						r.url.includes("/open-apis/cardkit/v1/cards") &&
						(r as { method?: string }).method === "POST",
				),
			{ label: "cardkit create" },
		);
		await h.waitFor(
			() =>
				h.fake.requests.some(
					(r) =>
						r.url.includes("/elements/stream_md/content") ||
						(r.url.match(/\/cards\/fake_card_\d+$/) !== null &&
							(r as { method?: string }).method === "PUT"),
				),
			{ label: "cardkit update/finalize" },
		);
		const deliveredCard = h.fake.messages.find((m) => {
			if (m.msgType !== "interactive") return false;
			try {
				const parsed = JSON.parse(m.content) as { type?: string };
				return parsed.type === "card";
			} catch {
				return false;
			}
		});
		assert.ok(deliveredCard, "the run card entity was delivered into the chat");
		// the run card owns delivery — no plain assistant-output text for this turn
		const payloads = outboxPayloads(h, "assistant-output");
		assert.ok(
			!payloads.some((p) => String(p.text ?? "").includes("卡片回复内容")),
			"run-card mode must not duplicate the reply as a plain message",
		);
		// final PUT carries the rendered text and streaming_mode:false
		const finalPut = h.fake.requests.find(
			(r) =>
				/\/cards\/fake_card_\d+$/.test(r.url) &&
				(r as { method?: string }).method === "PUT",
		);
		assert.ok(finalPut, "final whole-card PUT issued");
		const body = JSON.stringify(finalPut?.data);
		assert.ok(body.includes("卡片回复内容"), "final card carries the reply text");
	});
});

// ---------------------------------------------------------------------------
// 8. wechat flagOff — WeChat channel must not be applied when enabled="0"
// ---------------------------------------------------------------------------

test('wechat.enabled="0" never reaches applyWechatChannel', async () => {
	const logs: string[] = [];
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	try {
		await withHarness({ rawConfig: { enabled: true, wechat: { enabled: "0" } } }, async (h) => {
			const wechatRoutes = [...h.routes.keys()].filter((path) =>
				path.startsWith("/wechat"),
			);
			assert.deepEqual(wechatRoutes, [], "no WeChat HTTP routes registered");
			assert.deepEqual(
				logs.filter((line) => line.includes("[dsh-wechat]")),
				[],
				"applyWechatChannel was never invoked",
			);
		});
	} finally {
		console.warn = originalWarn;
		console.log = originalLog;
	}
});

test("wechat enabled (control): applyWechatChannel IS invoked on a fake host", async () => {
	const logs: string[] = [];
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	try {
		await withHarness(
			{ rawConfig: { enabled: true, wechat: { enabled: "1" } } },
			async (h) => {
				// The fake ctx has no ctx.inject → the channel is inert but the call
				// itself is observable, proving "0" above really short-circuited.
				assert.ok(
					logs.some((line) => line.includes("[dsh-wechat]")),
					"WeChat channel entry point was reached when enabled != 0",
				);
				assert.equal(h.fake.dispatchers.length, 1, "Feishu bridge still works");
			},
		);
	} finally {
		console.warn = originalWarn;
		console.log = originalLog;
	}
});

// ---------------------------------------------------------------------------
// Robustness: main plugin flagOff (enabled="0") skips apply() entirely
// ---------------------------------------------------------------------------

test('plugin enabled="0" registers nothing (normalized on/off toggle)', async () => {
	const h = await createApplyHarness({ rawConfig: { enabled: "0" } });
	try {
		assert.deepEqual(h.tools, []);
		assert.deepEqual(h.commands, []);
		assert.deepEqual(h.effects, []);
		assert.deepEqual([...h.routes.keys()], []);
	} finally {
		await h.teardown();
	}
});
