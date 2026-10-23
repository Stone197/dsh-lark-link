// CommandRouter: the three-tier command dispatch (ADR-7, spec §4.2):
//   1. bridge-specific commands (/status /support /lark-config …) → bridge
//   2. DSH-registered commands → native handler({agent, rawInput})
//   3. everything else (plugin commands, /skill:x, unknown /xxx, plain text)
//      → injected verbatim into the agent
// No blocked commands, no admin gates (user decision: 无审批, 全放开).
//
// Tier-1 aliases handled HERE (they need no host wiring):
//   - `/cd <路径>`      = the existing `/workspace` switch, forwarded verbatim
//                        (relative-path resolution, per-conversation override,
//                        session rotation and the reply all stay in the one
//                        handler).
//   - `/ws list|add|use|remove|status`
//                        = saved-workspace store under
//                        <DSH_HOME>/lark-link/workspaces.json. `use` forwards
//                        the chosen absolute path to the same `/workspace`
//                        handler, so the per-conversation override is updated
//                        exactly like a manual switch; `list` replies with a
//                        button card whose buttons carry the EXISTING
//                        `workspace:<path>` op (the card-action path already
//                        dispatches it — no second callback surface).

import { statSync } from "node:fs";
import type { FeishuInboundMessage } from "../common/types.ts";
import { isAbsoluteAny, resolveWorkspaceTarget } from "../common/paths.ts";
import {
	createSavedWorkspaceStore,
	defaultWorkspacesFile,
	findSavedWorkspace,
	type SavedWorkspaceStore,
} from "../sessions/workspace-sessions.ts";
import { workspaceListCard } from "../presentation/cards.ts";
import type { BridgeContextRead } from "./bridge-context.ts";

export interface DshCommandRegistry {
	/** Look up a registered command handler by name for the agent (no leading slash). */
	has(name: string, agentId?: string): boolean;
	run(
		name: string,
		rawInput: string,
		agentId: string,
	): Promise<{ kind: string; text?: string }>;
}

export interface CommandRouterDeps {
	ctx: BridgeContextRead;
	commands: DshCommandRegistry;
	/** Handle a bridge-specific command; returns handled=true when consumed. */
	bridgeHandler(
		name: string,
		rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean>;
	/**
	 * Saved-workspace store for `/ws` (tests inject a temp-dir store). When
	 * omitted, the real store at {@link defaultWorkspacesFile} is used.
	 */
	savedWorkspaces?: SavedWorkspaceStore;
	/** Override the workspaces.json path (defaults to <DSH_HOME>/lark-link). */
	workspacesFile?: string;
	/**
	 * Per-conversation workspace override reader (the host wires
	 * `convCfg.get(key).workspaceRoot`). Optional: without it `/ws` resolves
	 * relative paths against the bridge default and labels it 默认工作区.
	 */
	workspaceRootFor?: (conversationKey: string) => string | undefined;
	/**
	 * Effective default workspace (the host wires the GUI's current workspace).
	 * Optional: falls back to config.workspaceRoot / process.cwd().
	 */
	defaultWorkspace?: () => string;
	/** Clock injection (saved-workspace timestamps in tests). */
	now?: () => number;
}

export interface CommandRouter {
	/** Route an inbound message (or its text) through the tiers. */
	route(
		msg: FeishuInboundMessage,
	): Promise<"bridge" | "dsh" | "agent" | "skipped">;
	/** True when the message starts with a slash. */
	isCommand(text: string): boolean;
	/**
	 * Handle a `/ws …` request or a `ws:<arg>` card-action op.
	 *
	 * Exposed for the host's card-action branch: after it splits the op at the
	 * first colon, `cmd === "ws"` can be delegated here instead of adding a
	 * second copy of the saved-workspace logic to `bridgeHandler`.
	 * Always consumes (it always replies).
	 */
	handleWorkspace(
		rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean>;
}

const BRIDGE_COMMANDS = new Set([
	"status",
	"workspace",
	"stop",
	"support",
	"doctor",
	"sessions",
	"lark-config",
	"help",
	"feishu-config",
	"model",
	"mode",
	"permission",
	"new",
	// Feishu-side history picker — Tier 1 wins over DSH's own /resume so the
	// workspace-session card renders instead of a bare text reply.
	"resume",
	// Feishu-side goal controller — Tier 1 renders interactive goal deck / templates.
	"goal",
]);


export function stripLeadingMentions(text: string): string {
	let cur = text.trim();
	while (true) {
		const next = cur.replace(/^(?:<at[^>]*>.*?<\/at>|@\S+)\s*/i, "").trim();
		if (next === cur) break;
		cur = next;
	}
	return cur;
}

/** Usage line shared by every `/ws` error branch. */
const WS_USAGE =
	"用法：/ws list | add <路径> | use <编号|路径> | remove <编号|路径> | status";


/** `/ws` subcommand keywords (also the card-action op names). */
const WS_SUBS = new Set([
	"list",
	"status",
	"add",
	"save",
	"use",
	"switch",
	"go",
	"remove",
	"rm",
	"del",
]);

/** Narrow dependency slice the /ws + /cd helpers need. */
export interface WorkspaceCommandDeps {
	ctx: BridgeContextRead;
	bridgeHandler(
		name: string,
		rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean>;
	/** Saved-workspace store override (tests inject a temp-dir store). */
	savedWorkspaces?: SavedWorkspaceStore;
	/** Override the workspaces.json path (defaults to <DSH_HOME>/lark-link). */
	workspacesFile?: string;
	/** Per-conversation workspace override reader (wired by the host). */
	workspaceRootFor?: (conversationKey: string) => string | undefined;
	/**
	 * Effective default workspace (the host wires the GUI's current workspace).
	 * Optional: falls back to config.workspaceRoot / process.cwd().
	 */
	defaultWorkspace?: () => string;
	/** Clock injection (saved-workspace timestamps in tests). */
	now?: () => number;
}

/**
 * `/ws` behaviour, shared by the TEXT router (tier 0) and the CARD-ACTION
 * path (a `ws:*` op). Exported so the host can delegate a card click:
 *
 *   if (cmd === "ws") { await commandRouter.handleWorkspace(arg, pseudo); return; }
 *
 * (`handleWorkspace` is the same function; the alias exists so the host does
 * not need to know the text spelling.)
 */
export interface WorkspaceCommandHandler {
	/** Handle `/ws …` or a card-action arg (`list`, `use:2`, …). Always consumes. */
	handleWs(rawInput: string, msg: FeishuInboundMessage): Promise<void>;
}

export function createWorkspaceCommandHandler(
	deps: WorkspaceCommandDeps,
): WorkspaceCommandHandler & { markDone(msg: FeishuInboundMessage): void } {
const now = deps.now ?? Date.now;
const savedWorkspaces =
	deps.savedWorkspaces ??
	createSavedWorkspaceStore(deps.workspacesFile ?? defaultWorkspacesFile(), now);
const keyOf = (msg: FeishuInboundMessage): string =>
	deps.ctx.conversationKeyFor(msg);
const defaultWorkspace = (): string =>
	deps.defaultWorkspace?.() ?? (deps.ctx.cfg().workspaceRoot || process.cwd());
/** This conversation's workspace: per-key override (when wired) ?? default. */
const currentWorkspace = (msg: FeishuInboundMessage): string =>
	deps.workspaceRootFor?.(keyOf(msg)) ?? defaultWorkspace();

/** Same DONE receipt the tier-1 dispatcher adds to command replies. */
const markDone = (msg: FeishuInboundMessage): void => {
	const cfg = deps.ctx.cfg();
	if (!cfg.reactions.enabled) return;
	void deps.ctx.sender
		?.addReaction(msg.messageId, cfg.reactions.done || "DONE")
		.catch(() => undefined);
};

/**
 * Durable command reply (same outbox lane as the host's `durableReply`):
 * a /ws card or text answer survives a crash between "command accepted"
 * and "reply delivered".
 */
const enqueueReply = async (
	cmdName: string,
	msg: FeishuInboundMessage,
	payload:
		| { kind: "text"; text: string }
		| { kind: "card"; card: unknown; text?: string },
): Promise<void> => {
	const outbox = deps.ctx.outbox;
	if (!outbox) return;
	const key = keyOf(msg);
	await outbox.enqueue({
		dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
		laneKey: key,
		route: {
			sessionKey: key,
			chatId: msg.chatId,
			chatType: msg.chatType,
		},
		kind: "command-reply",
		payload,
	});
};
const replyText = (
	cmdName: string,
	msg: FeishuInboundMessage,
	text: string,
): Promise<void> => enqueueReply(cmdName, msg, { kind: "text", text });
const replyCard = (
	cmdName: string,
	msg: FeishuInboundMessage,
	card: unknown,
	fallbackText?: string,
): Promise<void> =>
	enqueueReply(cmdName, msg, {
		kind: "card",
		card,
		...(fallbackText ? { text: fallbackText } : {}),
	});

/** Validate a directory target; returns the user-facing error, if any. */
const inspectDirectory = (target: string): string | undefined => {
	if (!isAbsoluteAny(target)) return `无效路径: ${target}`;
	try {
		if (!statSync(target).isDirectory()) return `不是有效目录: ${target}`;
	} catch {
		return `目录不存在: ${target}`;
	}
	return undefined;
};

/** `/ws list` — button card, one switch button per saved workspace. */
const sendWorkspaceList = async (msg: FeishuInboundMessage): Promise<void> => {
	const entries = savedWorkspaces.list();
	const hasOverrideReader = typeof deps.workspaceRootFor === "function";
	const current = hasOverrideReader ? currentWorkspace(msg) : defaultWorkspace();
	// Plain-text fallback travels WITH the card payload: if the card cannot be
	// rendered/delivered (e.g. a client that rejects schema 2.0), the host's
	// outbox sender can fall back to this text instead of losing the reply.
	const fallback = [
		"收藏工作区",
		`当前: ${current}`,
		...entries.map((entry, index) => `#${index + 1} ${entry.path}`),
		"",
		"/ws add 路径 收藏 · /ws use 编号 切换 · /ws remove 编号 删除 · /cd 路径 直接切换",
	].join("\n");
	await replyCard(
		"ws",
		msg,
		workspaceListCard(entries, {
			current,
			currentLabel: hasOverrideReader ? "当前工作区" : "默认工作区",
		}),
		fallback,
	);
};

/** `/ws status` — text: current workspace + the saved list. */
const sendWorkspaceStatus = async (msg: FeishuInboundMessage): Promise<void> => {
	const entries = savedWorkspaces.list();
	const hasOverrideReader = typeof deps.workspaceRootFor === "function";
	const lines: string[] = [
		`**工作区**`,
		`- 当前: ${currentWorkspace(msg)}${hasOverrideReader ? "" : "（默认，当前会话可用 /cd 查看）"}`,
		`- 收藏: ${entries.length} 个（${savedWorkspaces.file()}）`,
	];
	if (entries.length === 0) {
		lines.push("", "发送 `/ws add /绝对路径` 收藏一个目录。");
	} else {
		entries.forEach((entry, index) => {
			lines.push(`- #${index + 1} ${entry.path}`);
		});
		lines.push("", "`/ws use 编号` 切换 · `/ws remove 编号` 删除");
	}
	await replyText("ws", msg, lines.join("\n"));
};

/** `/ws add <path>` — save an absolute path (never switches). */
const addWorkspace = async (
	raw: string,
	msg: FeishuInboundMessage,
): Promise<void> => {
	if (!raw) {
		await replyText("ws", msg, WS_USAGE);
		return;
	}
	const target = resolveWorkspaceTarget(raw, currentWorkspace(msg));
	const problem = inspectDirectory(target);
	if (problem) {
		await replyText("ws", msg, problem);
		return;
	}
	const { added, entry, index } = savedWorkspaces.add(target);
	await replyText(
		"ws",
		msg,
		added
			? `已收藏工作区: ${entry.path}\n发送 /ws use ${index + 1} 或 /cd ${entry.path} 切换。`
			: `已在收藏中: ${entry.path}（/ws use ${index + 1} 切换）`,
	);
};

/**
 * `/ws use <编号|路径>` — switch THIS conversation's workspace.
 *
 * Delegates to the existing `/workspace` handler, which owns relative-path
 * resolution, the per-conversation override and the session rotation; this
 * function only resolves the saved-workspace reference first.
 */
const useWorkspace = async (
	raw: string,
	msg: FeishuInboundMessage,
): Promise<void> => {
	if (!raw) {
		await replyText("ws", msg, WS_USAGE);
		return;
	}
	const entries = savedWorkspaces.list();
	const saved = findSavedWorkspace(entries, raw);
	let target: string | undefined;
	if (saved) {
		target = saved.entry.path;
	} else {
		// Allow a direct path too (same ergonomics as /cd); it does not have
		// to be saved first.
		const resolved = resolveWorkspaceTarget(raw, currentWorkspace(msg));
		if (isAbsoluteAny(resolved) && inspectDirectory(resolved) === undefined) {
			target = resolved;
		}
	}
	if (!target) {
		await replyText(
			"ws",
			msg,
			`未找到收藏工作区 «${raw}»（发送 /ws list 查看；或先 /ws add 收藏）`,
		);
		return;
	}
	const handled = await deps.bridgeHandler("workspace", target, msg);
	if (!handled) {
		await replyText("ws", msg, `切换失败: ${target}`);
		return;
	}
	savedWorkspaces.touch(target);
	markDone(msg);
};

/** `/ws remove <编号|路径>` — delete one saved entry. */
const removeWorkspace = async (
	raw: string,
	msg: FeishuInboundMessage,
): Promise<void> => {
	const saved = findSavedWorkspace(savedWorkspaces.list(), raw);
	if (!saved || !savedWorkspaces.remove(saved.entry.path)) {
		await replyText(
			"ws",
			msg,
			raw ? `未找到收藏工作区 «${raw}»（发送 /ws list 查看）` : WS_USAGE,
		);
		return;
	}
	await replyText(
		"ws",
		msg,
		`已删除收藏工作区: ${saved.entry.path}${
			savedWorkspaces.list().length === 0 ? "（列表已空）" : "（/ws list 查看剩余）"
		}`,
	);
};

/** `/ws …` dispatcher. Always replies, so it always consumes the message. */
const handleWs = async (
	rawInput: string,
	msg: FeishuInboundMessage,
): Promise<void> => {
	const text = rawInput.trim();
	const sep = text.search(/\s/);
	let sub = (sep === -1 ? text : text.slice(0, sep)).toLowerCase();
	let rest = sep === -1 ? "" : text.slice(sep + 1).trim();
	if (sep === -1) {
		// Card-action ops arrive as `ws:<sub>` / `ws:<sub>:<arg>`: the host
		// splits op at the FIRST colon, so rebuild the space-separated form.
		const colon = text.indexOf(":");
		const head = colon > 0 ? text.slice(0, colon).toLowerCase() : "";
		if (WS_SUBS.has(head)) {
			sub = head;
			rest = text.slice(colon + 1).trim();
		}
	}
	switch (sub) {
		case "":
		case "list":
			await sendWorkspaceList(msg);
			return;
		case "status":
			await sendWorkspaceStatus(msg);
			return;
		case "add":
		case "save":
			await addWorkspace(rest, msg);
			return;
		case "use":
		case "switch":
		case "go":
			await useWorkspace(rest, msg);
			return;
		case "remove":
		case "rm":
		case "del":
			await removeWorkspace(rest, msg);
			return;
		default: {
			// `/ws 2` / `/ws /path` — friendly shorthand for `use`.
			const pathish =
				/^\d+$/.test(sub) ||
				sub.startsWith("~") ||
				sub.startsWith(".") ||
				isAbsoluteAny(text);
			if (pathish) {
				await useWorkspace(text, msg);
				return;
			}
			await replyText("ws", msg, WS_USAGE);
		}
	}
};

	return { handleWs, markDone };
}

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
	const workspaceCommands = createWorkspaceCommandHandler(deps);
	const markDone = workspaceCommands.markDone;
	const handleWs = workspaceCommands.handleWs;


	return {
		isCommand(text) {
			const cleaned = stripLeadingMentions(text);
			return /^\//.test(cleaned);
		},
		async handleWorkspace(rawInput, msg) {
			await workspaceCommands.handleWs(rawInput, msg);
			return true;
		},
		async route(msg) {
			const rawText = (msg.text ?? msg.content ?? "").trim();
			if (rawText === "") return "skipped";

			const text = stripLeadingMentions(rawText);
			if (text === "") return "skipped";
			if (!this.isCommand(rawText)) return "agent"; // plain message → agent

			// Tier 0: workspace ergonomics aliases (/cd, /ws).
			const head = text.split(/\s+/)[0] ?? "";
			const cmdName = head.replace(/^\/+/, "").toLowerCase();
			const rawInput = text.split(/\s+/).slice(1).join(" ");
			if (cmdName === "cd") {
				// `/cd` is exactly `/workspace`; forward the raw argument so the
				// existing handler resolves it against the conversation's
				// current workspace and persists the per-conversation override.
				const handled = await deps.bridgeHandler("workspace", rawInput, msg);
				if (!handled) return "agent";
				markDone(msg);
				return "bridge";
			}
			if (cmdName === "ws") {
				await handleWs(rawInput, msg);
				markDone(msg);
				return "bridge";
			}

			// Tier 1: bridge-specific
			if (BRIDGE_COMMANDS.has(cmdName) || cmdName === "lark") {
				const handled = await deps.bridgeHandler(cmdName, rawInput, msg);
				if (handled) {
					// Command replies get the DONE receipt too (pi design:
					// 任务完成 → 对触发消息打 DONE)，so /help /status confirm
					// completion instead of silently ending.
					markDone(msg);
				}
				return handled ? "bridge" : "agent";
			}

			// Tier 2: DSH-registered commands (native handler, no model round-trip).
			// Commands resolve per agent — lazy-create the session agent when the
			// first message of a conversation is a command (otherwise every
			// DSH command fails on a fresh chat).
			const key2 = deps.ctx.conversationKeyFor(msg);
			let agent = deps.ctx.backend?.get(key2);
			if (!agent) {
				try {
					agent = await deps.ctx.backend?.ensureAgent?.(key2);
				} catch {
					// fall through to agent
				}
			}
			const agentId = agent?.agentId ?? "";
			if (agentId && deps.commands.has(cmdName, agentId)) {
				try {
					const result = await deps.commands.run(cmdName, rawInput, agentId);
					const key = deps.ctx.conversationKeyFor(msg);
					if (result.kind === "success" && result.text) {
						await deps.ctx.outbox?.enqueue({
							dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
							laneKey: key,
							route: {
								sessionKey: key,
								chatId: msg.chatId,
								chatType: msg.chatType,
							},
							kind: "command-reply",
							payload: { kind: "text", text: result.text },
						});
					} else if (result.kind === "error" && result.text) {
						await deps.ctx.outbox?.enqueue({
							dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
							laneKey: key,
							route: {
								sessionKey: key,
								chatId: msg.chatId,
								chatType: msg.chatType,
							},
							kind: "command-reply",
							payload: { kind: "text", text: `⚠️ ${result.text}` },
						});
					}
					return "dsh";
				} catch {
					return "agent"; // handler failed — fall through to the agent
				}
			}

			// Tier 3: everything else passes verbatim to the agent
			return "agent";
		},
	};
}
