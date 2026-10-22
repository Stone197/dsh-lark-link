// Ported from pan17/dsh-wechat v0.13.3 (MIT) — WeChat channel of the
// unified dsh-lark-link plugin. New in the unified bridge: `/cd` alias.
/**
 * `/cd <路径>` — the unified bridge's documented shorthand for
 * `/workspace switch <路径>` (docs/UNIFIED-IM-BRIDGE.md, "WeChat already has
 * `/ws` (list/switch/add); add `/cd` alias in `src/wechat/bridge/slash.ts`").
 *
 * The Feishu half exposes the same alias, and the shared help catalog
 * (`src/help/catalog.ts`) documents it for BOTH channels — so the alias must
 * be (a) parsed, (b) whitelisted against native-command shadowing and
 * (c) dispatched through the existing workspace handler, not a second code
 * path. These cases pin all three.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/wechat/weixin/send.js", () => ({
	sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
	sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
	splitText: (text: string) => [text],
}));

import { WeChatDSHBridge } from "../src/wechat/bridge/bridge.js";
import { defaultConfig } from "../src/wechat/config.js";
import {
	LOCAL_COMMAND_NAMES,
	formatHelp,
	isBypassSlashCommand,
	parseWorkspaceCommand,
} from "../src/wechat/bridge/slash.js";
import { helpCatalog } from "../src/wechat/help-catalog.js";
import { MessageType } from "../src/wechat/weixin/types.js";

function makeBridge() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cd-"));
	const agent = {
		id: "session-cd",
		status: "idle",
		options: { provider: "deepseek", model: "deepseek-chat" },
		followup: () => {},
		steer: () => {},
		cancel: () => {},
		whenIdle: async () => {},
	};
	const ctx = {
		get: (name: string) =>
			name === "agents"
				? {
						create: async () => ({ agent }),
						resume: async () => ({ agent }),
						get: (id: string) => (id === agent.id ? agent : undefined),
						list: () => [agent],
					}
				: undefined,
		on: () => () => {},
	};
	const cfg = defaultConfig();
	cfg.storageDir = dir;
	cfg.mergeSilenceMs = 0;
	const bridge = new WeChatDSHBridge(ctx as never, cfg);
	(bridge as unknown as { token: unknown }).token = {
		baseUrl: "https://gw",
		token: "t",
		accountId: "b1",
		userId: "u",
		savedAt: "",
	};
	const internals = bridge as unknown as {
		state: {
			ensureUser(u: string, c: string): unknown;
			update(u: string, patch: unknown): void;
			getUser(u: string): { userId: string; cwd: string; sessionId: string };
		};
	};
	internals.state.ensureUser("u1", dir);
	internals.state.update("u1", { sessionId: "session-cd" });
	return { bridge, dir, internals };
}

const textMessage = (text: string) => ({
	message_type: MessageType.USER,
	from_user_id: "u1",
	context_token: "ctx-token",
	item_list: [{ type: 1, text_item: { text } }],
});

describe("/cd parser", () => {
	it("maps /cd <path> onto the /workspace switch command", () => {
		expect(parseWorkspaceCommand("/cd /tmp/work")).toEqual({ kind: "switch", target: "/tmp/work" });
		expect(parseWorkspaceCommand("/cd C:\\projects\\my-app")).toEqual({
			kind: "switch",
			target: "C:\\projects\\my-app",
		});
		expect(parseWorkspaceCommand("/cd ~/work")).toEqual({ kind: "switch", target: "~/work" });
		expect(parseWorkspaceCommand("  /cd   ~/work  ")).toEqual({ kind: "switch", target: "~/work" });
	});

	it("reports status for a bare /cd instead of forwarding it to the agent", () => {
		expect(parseWorkspaceCommand("/cd")).toEqual({ kind: "status" });
	});

	it("does not steal other commands or chat", () => {
		expect(parseWorkspaceCommand("/cdx /tmp")).toBeNull();
		expect(parseWorkspaceCommand("/cdfoo")).toBeNull();
		expect(parseWorkspaceCommand("/workspace switch /tmp")).toEqual({
			kind: "switch",
			target: "/tmp",
		});
	});

	it("bypasses a pending card and shadows no native command", () => {
		expect(isBypassSlashCommand("/cd /tmp/work")).toBe(true);
		expect(LOCAL_COMMAND_NAMES.has("cd")).toBe(true);
	});

	it("is documented by the shared help catalog and the /help listing", () => {
		expect(helpCatalog().commands.some((entry) => entry.command === "/cd")).toBe(true);
		expect(formatHelp()).toContain("/cd");
	});
});

describe("/cd dispatch", () => {
	let bridge: WeChatDSHBridge;
	let dir: string;
	let internals: ReturnType<typeof makeBridge>["internals"];

	beforeEach(() => {
		vi.clearAllMocks();
		sendTextMessage.mockReset().mockResolvedValue(undefined);
		const made = makeBridge();
		bridge = made.bridge;
		dir = made.dir;
		internals = made.internals;
	});

	afterEach(async () => {
		await bridge.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("/cd <dir> switches the bound user's workspace through the existing handler", async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cd-target-"));
		try {
			const anyBridge = bridge as unknown as {
				ops: Record<string, unknown>;
				handleMessage(msg: unknown): Promise<void>;
			};
			// Same handler as `/workspace switch`: resolve the path as a workspace.
			anyBridge.ops.resolveWorkspaceByPath = async (p: string) => ({
				id: "w1",
				path: p,
				title: path.basename(p),
				sessionIds: [],
			});
			anyBridge.ops.listWorkspaces = () => [];
			anyBridge.ops.archivedSessionIds = () => [];
			anyBridge.ops.readSessionTitle = async () => undefined;

			await anyBridge.handleMessage(textMessage(`/cd ${target}`));

			expect(internals.state.getUser("u1").cwd).toBe(target);
			const reply = String(sendTextMessage.mock.calls[0]?.[1] ?? "");
			expect(reply).toContain("已切换到工作区");
			expect(reply).toContain(target);
		} finally {
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	it("bare /cd answers with the current-workspace status", async () => {
		const anyBridge = bridge as unknown as { handleMessage(msg: unknown): Promise<void> };
		await anyBridge.handleMessage(textMessage("/cd"));
		const reply = String(sendTextMessage.mock.calls[0]?.[1] ?? "");
		expect(reply).toContain("当前工作区");
		expect(reply).toContain(dir);
	});
});
