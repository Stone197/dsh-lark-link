// "Fake Cordis ctx + REAL apply()" integration harness.
//
// Why this exists (BUG audit A): test/integration/smoke.test.ts only proves that
// apply() assembles without throwing. It never drives the command pipeline, so
// every user-visible reply (/model card, /help, /status, /new, /cd, /ws, /mode,
// /permission, plain turns, run-cards, the WeChat gate) was untested end-to-end.
//
// How it works:
//   1. A Node module customization hook (fixtures/lark-sdk-hooks.mjs) resolves
//      `@larksuiteoapi/node-sdk` to fixtures/fake-lark-sdk.mjs. That is the ONLY
//      production dependency replaced: apply() still builds the real lark
//      client adapter, transport, command router, outbox, forwarder, cards…
//   2. A hand-written fake Cordis Context supplies the host services apply()
//      reads through `ctx.get(...)` / direct properties, captures every
//      registration (tools, commands, effects, ctx.on, webServer routes) and
//      lets the harness run the lifecycle effect (real startBridge) and feed
//      raw Feishu events through the captured EventDispatcher handler.
//   3. Outbound messages land in the fake SDK's registry (sendMessage /
//      reactions / cardkit requests); durable envelopes are also on disk in a
//      mkdtemp state dir, so payloads can be asserted either way.
//
// No user state is touched: DSH_HOME + DSH_LARK_LINK_HOME always point inside a
// mkdtemp directory and are restored on teardown.

import { register } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must run BEFORE src/index.ts is imported: apply() -> startBridge() ->
// buildLarkClient() dynamically imports the SDK, and the loader hook only
// applies to module loads that happen after register(). This file therefore
// imports the plugin entry with a dynamic import at the bottom of the setup.
register(new URL("./fixtures/lark-sdk-hooks.mjs", import.meta.url).href);

const plugin = await import("../../src/index.ts");
export const apply = plugin.apply;
export const stateDir = plugin.stateDir;

// ---- captured Feishu SDK surface ------------------------------------------

export interface FakeSentMessage {
	receiveId: string;
	receiveIdType?: string;
	msgType: string;
	content: string;
}

export interface FakeLarkState {
	clients: unknown[];
	dispatchers: Array<{ handlers: Record<string, (data: unknown) => void> }>;
	wsClients: unknown[];
	messages: FakeSentMessage[];
	reactions: Array<{ message_id?: string; emoji_type?: string }>;
	requests: Array<{ url: string; method?: string; data?: unknown; params?: unknown }>;
	cardSeq: number;
	msgSeq: number;
	reset(): void;
}

export function fakeLark(): FakeLarkState {
	const holder = globalThis as { __DSH_FAKE_LARK__?: FakeLarkState };
	// The fake SDK module (loaded lazily by buildLarkClient via the module hook)
	// initializes this registry with `??=`; pre-create it here so the harness can
	// read it before the first SDK import and so every harness sees the same
	// object across runs.
	holder.__DSH_FAKE_LARK__ ??= {
		clients: [],
		dispatchers: [],
		wsClients: [],
		messages: [],
		reactions: [],
		requests: [],
		cardSeq: 0,
		msgSeq: 0,
		reset() {
			this.clients.length = 0;
			this.dispatchers.length = 0;
			this.wsClients.length = 0;
			this.messages.length = 0;
			this.reactions.length = 0;
			this.requests.length = 0;
			this.cardSeq = 0;
			this.msgSeq = 0;
		},
	};
	return holder.__DSH_FAKE_LARK__;
}

// ---- fake host services ----------------------------------------------------

export interface LlmFake {
	listProviders?(): Array<{ id?: string; name?: string }>;
	listConfigurableProviders?(): Array<{ provider?: string; displayName?: string; id?: string; name?: string }>;
	listModels?(provider: string): Promise<Array<{ id: string; name?: string }>>;
}

export interface FakeAgent {
	id: string;
	session: { id: string };
	status: "idle";
	ctx: {
		on(event: string, fn: (...args: unknown[]) => unknown): () => void;
	};
	followups: unknown[];
	followup(message: unknown): void;
	cancel(opts?: unknown): void;
	whenIdle(): Promise<void>;
}

interface FakeAgentsState {
	created: FakeAgent[];
	disposed: string[];
	lastFollowup?: unknown;
}

export interface HarnessState {
	/** Live object: replacing fields changes /model behaviour between commands. */
	llm: LlmFake | undefined;
	defaultModel: { provider: string; model: string } | undefined;
	agentPresets: Array<{
		id: string;
		name?: string;
		trust?: "system" | "user";
		description?: string;
		broken?: string;
	}>;
	credentials: { appId: string; appSecret: string; domain: "feishu" | "lark" } | undefined;
	agents: FakeAgentsState;
	permissionApplies: Array<{ preset: string; sessionId?: string }>;
	approvalPolicies: string[];
	imageSaves: number;
	attachments: unknown[];
}

export interface ApplyHarnessOptions {
	/** Raw plugin config passed to apply(). Defaults to Feishu-only (wechat off). */
	rawConfig?: Record<string, unknown>;
	/** Mutate temp dirs / write files BEFORE apply() runs (e.g. DSH_HOME stores). */
	prepare?(dirs: HarnessDirs): void;
	llm?: LlmFake;
	defaultModel?: { provider: string; model: string };
	agentPresets?: HarnessState["agentPresets"];
	/** Skip running the plugin lifecycle effect (no bridge auto-start). */
	manualLifecycle?: boolean;
}

export interface HarnessDirs {
	root: string;
	dshHome: string;
	stateDir: string;
}

export interface RegisteredDshCommand {
	name: string;
	description?: string;
	input?: { hint?: string };
	handler(inv: { rawInput?: string }): Promise<{ kind: string; text?: string }>;
}

export interface ApplyHarness {
	dirs: HarnessDirs;
	state: HarnessState;
	fake: FakeLarkState;
	/** Tools registered on ctx.tools. */
	tools: Array<Record<string, unknown>>;
	/** DSH commands registered on ctx.commands. */
	commands: RegisteredDshCommand[];
	/** ctx.effect callbacks, in registration order (all were invoked on boot). */
	effects: Array<() => unknown>;
	/** Web routes registered on the fake ctx.webServer (path → handler). */
	routes: Map<string, (req: unknown, res: unknown) => unknown>;
	/** Run one captured DSH command handler (the /lark dispatcher etc). */
	runDshCommand(name: string, rawInput?: string): Promise<{ kind: string; text?: string }>;
	/** Feed a raw Feishu message event through the captured EventDispatcher. */
	sendInbound(text: string, opts?: { chatId?: string; messageId?: string; chatType?: "p2p" | "group" }): string;
	/** Feed a raw card.action.trigger event (a button click). */
	sendCardAction(op: string, opts?: { chatId?: string; messageId?: string }): void;
	/** Emit one DSH session event as the agent runtime would. */
	emitSessionEvent(event: unknown, session?: unknown): void;
	/** Wait until at least one agent was created by an inbound message. */
	waitForAgent(timeoutMs?: number): Promise<FakeAgent>;
	/** Parsed JSON of every interactive message the bridge sent. */
	cardPayloads(): unknown[];
	/** Plain-text bodies of every text message the bridge sent. */
	textBodies(): string[];
	/** Durable envelopes persisted by the outbox (newest last). */
	outboxEnvelopes(): Array<Record<string, unknown>>;
	waitFor<T>(
		fn: () => T | undefined | false | Promise<T | undefined | false>,
		opts?: { timeoutMs?: number; label?: string },
	): Promise<T>;
	teardown(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 8000;
	const intervalMs = opts.intervalMs ?? 10;
	const started = Date.now();
	let last: unknown;
	while (Date.now() - started < timeoutMs) {
		try {
			const value = await fn();
			if (value) return value as T;
		} catch (err) {
			last = err;
		}
		await sleep(intervalMs);
	}
	throw new Error(
		`waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}${
			last ? `: ${last instanceof Error ? last.message : String(last)}` : ""
		}`,
	);
}

export async function createApplyHarness(opts: ApplyHarnessOptions = {}): Promise<ApplyHarness> {
	const root = mkdtempSync(join(tmpdir(), "dsh-lark-apply-"));
	const dshHome = join(root, "dsh-home");
	const state = join(dshHome, "lark-link");
	const dirs: HarnessDirs = { root, dshHome, stateDir: state };
	mkdirSync(state, { recursive: true });

	const prevDshHome = process.env.DSH_HOME;
	const prevLarkHome = process.env.DSH_LARK_LINK_HOME;
	process.env.DSH_HOME = dshHome;
	process.env.DSH_LARK_LINK_HOME = state;

	opts.prepare?.(dirs);

	const fake = fakeLark();
	fake.reset();

	const harnessState: HarnessState = {
		llm: opts.llm,
		defaultModel: opts.defaultModel,
		agentPresets: opts.agentPresets ?? [
			{ id: "standard", name: "标准模式", trust: "system" },
			{ id: "ptc", name: "PTC 模式", trust: "system" },
			{ id: "minimal", name: "极简模式", trust: "system" },
		],
		credentials: { appId: "cli_fake_app", appSecret: "fake_secret", domain: "feishu" },
		agents: { created: [], disposed: [] },
		permissionApplies: [],
		approvalPolicies: [],
		imageSaves: 0,
		attachments: [],
	};

	const tools: Array<Record<string, unknown>> = [];
	const commands: RegisteredDshCommand[] = [];
	const effects: Array<() => unknown> = [];
	const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
	const onHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const teardowns: Array<() => unknown> = [];

	// ---- fake host services -------------------------------------------------
	const makeAgent = (sessionId: string): FakeAgent => {
		const agent: FakeAgent = {
			id: `agent_${sessionId}`,
			session: { id: sessionId },
			status: "idle",
			ctx: {
				on: () => () => undefined,
			},
			followups: [],
			followup(message: unknown) {
				agent.followups.push(message);
				harnessState.agents.lastFollowup = message;
			},
			cancel() {
				agent.status = "idle";
			},
			async whenIdle() {
				/* synchronous fake loop */
			},
		};
		harnessState.agents.created.push(agent);
		return agent;
	};

	const agentsService = {
		async create(args: { sessionId: string; meta?: unknown }) {
			const agent = makeAgent(args?.sessionId ?? "session");
			return {
				agent,
				async dispose() {
					harnessState.agents.disposed.push(agent.id);
				},
			};
		},
		async resume() {
			throw new Error("no resumable session in harness");
		},
		get(id: string) {
			return harnessState.agents.created.find(
				(a) => a.id === id || a.session.id === id,
			);
		},
	};

	const getService = (name: string): unknown => {
		switch (name) {
			case "llm":
				return harnessState.llm;
			case "agentDefaultModel":
				return harnessState.defaultModel
					? {
							currentSelection: () => harnessState.defaultModel,
							saveSelection: async () => undefined,
						}
					: undefined;
			case "agents":
				return agentsService;
			case "agentPresets":
				return {
					list: async () => harnessState.agentPresets,
					mount: async () => undefined,
				};
			case "workspaceRegistry":
				return {
					create: async () => ({ attachSession: async () => undefined }),
				};
			case "permissionPresets":
				return {
					apply: (
						session: { id?: string } | undefined,
						preset: string,
						setApproval: (policy: string) => void,
					) => {
						harnessState.permissionApplies.push({ preset, sessionId: session?.id });
						setApproval(`approval-for-${preset}`);
					},
				};
			case "approval":
				return {
					setPolicy: (_agent: unknown, policy: string) => {
						harnessState.approvalPolicies.push(policy);
					},
				};
			case "attachments":
				return {
					saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
						harnessState.imageSaves += 1;
						const attachment = {
							attachmentId: `att_${harnessState.imageSaves}`,
							mediaType: input.mediaType,
							bytes: input.data.byteLength,
							width: 1,
							height: 1,
							name: input.name,
						};
						harnessState.attachments.push(attachment);
						return attachment;
					},
				};
			case "sessionPersistence":
				return {
					list: async () => [],
					load: async () => undefined,
					inspect: async () => undefined,
					readFrom: async () => undefined,
					readRaw: async () => undefined,
				};
			case "sessionQuery":
				return { traceSession: async () => ({ descendants: [] }) };
			case "sessionTitle":
				return { get: () => undefined };
			case "sessions":
				return { get: () => undefined };
			case "goals":
				return { get: () => undefined, create: () => ({ id: "goal_fake" }) };
			case "planMode":
				return {};
			case "workspaces":
				return undefined;
			default:
				return undefined;
		}
	};

	const fakeCtx = {
		get: getService,
		// dsh-adapter reads these DIRECTLY off the Cordis context (not via get()):
		// ctx.agents.create/resume/get, ctx.on('session/event'), ctx.sessions.
		agents: agentsService,
		sessions: { get: () => undefined },
		config: opts.rawConfig ?? {},
		tools: {
			register(def: Record<string, unknown>) {
				tools.push(def);
				return () => undefined;
			},
		},
		commands: {
			register(def: RegisteredDshCommand) {
				commands.push(def);
				return () => undefined;
			},
			has: () => false,
			find: () => undefined,
			execute: async () => undefined,
		},
		systemPrompt: {
			section() {
				return () => undefined;
			},
		},
		credentials: {
			async resolve(ref: string) {
				void ref;
				return harnessState.credentials
					? { value: JSON.stringify(harnessState.credentials) }
					: undefined;
			},
			async set() {},
			async unset() {},
		},
		webServer: {
			register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }) {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			},
		},
		effect(fn: () => unknown) {
			effects.push(fn);
			return () => undefined;
		},
		on(event: string, fn: (...args: unknown[]) => unknown) {
			const list = onHandlers.get(event) ?? [];
			list.push(fn);
			onHandlers.set(event, list);
			return () => {
				const current = onHandlers.get(event) ?? [];
				const index = current.indexOf(fn);
				if (index >= 0) current.splice(index, 1);
			};
		},
	};

	// ---- run the real apply() ----------------------------------------------
	apply(fakeCtx as never, opts.rawConfig ?? { enabled: true, wechat: { enabled: "0" } });

	// Cordis runs ctx.effect callbacks on registration; emulate that here so
	// the real startBridge()/media-sweeper lifecycle takes place. The returned
	// disposers are kept for teardown (reverse order, like Cordis).
	const runEffects = (): void => {
		for (const effect of effects) {
			const disposer = effect();
			if (typeof disposer === "function") teardowns.push(disposer as () => unknown);
		}
	};
	if (!opts.manualLifecycle) runEffects();

	const dispatcher = (): FakeLarkState["dispatchers"][number] | undefined =>
		fake.dispatchers[fake.dispatchers.length - 1];

	const harness: ApplyHarness = {
		dirs,
		state: harnessState,
		fake,
		tools,
		commands,
		effects,
		routes,
		async runDshCommand(name, rawInput = "") {
			const command = commands.find((c) => c.name === name);
			if (!command)
				throw new Error(
					`command /${name} not registered (got: ${commands.map((c) => c.name).join(", ")})`,
				);
			return command.handler({ rawInput });
		},
		sendInbound(text, o = {}) {
			const chatId = o.chatId ?? "ou_user1";
			const messageId = o.messageId ?? `om_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const handler = dispatcher()?.handlers["im.message.receive_v1"];
			if (!handler) throw new Error("captured transport has no im.message.receive_v1 handler");
			const raw = {
				schema: "2.0",
				header: { event_type: "im.message.receive_v1" },
				event: {},
				message: {
					message_id: messageId,
					chat_id: chatId,
					chat_type: o.chatType ?? "p2p",
					message_type: "text",
					content: JSON.stringify({ text }),
					create_time: String(Date.now()),
				},
				sender: { sender_id: { open_id: chatId } },
			};
			handler(raw);
			return messageId;
		},
		sendCardAction(op, o = {}) {
			const chatId = o.chatId ?? "ou_user1";
			const handler = dispatcher()?.handlers["card.action.trigger"];
			if (!handler) throw new Error("captured transport has no card.action.trigger handler");
			handler({
				operator: { operator_id: { open_id: chatId } },
				action: { value: { op } },
				message: { message_id: o.messageId ?? "om_fake_card" },
			});
		},
		emitSessionEvent(event, session) {
			const listeners = onHandlers.get("session/event") ?? [];
			if (listeners.length === 0)
				throw new Error("agent runtime never subscribed to ctx.on('session/event')");
			for (const listener of listeners) listener(session, event);
		},
		async waitForAgent(timeoutMs = 4000) {
			return waitFor(() => harnessState.agents.created[0], {
				timeoutMs,
				label: "agent created",
			});
		},
		cardPayloads() {
			return fake.messages
				.filter((m) => m.msgType === "interactive")
				.map((m) => {
					try {
						return JSON.parse(m.content) as unknown;
					} catch {
						return m.content;
					}
				});
		},
		textBodies() {
			return fake.messages
				.filter((m) => m.msgType === "text")
				.map((m) => {
					try {
						const parsed = JSON.parse(m.content) as { text?: string };
						return parsed.text ?? m.content;
					} catch {
						return m.content;
					}
				});
		},
		outboxEnvelopes() {
			const dir = join(state, "outbox");
			if (!existsSync(dir)) return [];
			const files = readdirSync(dir)
				.filter((name) => /^seg-\d+\.jsonl$/.test(name))
				.sort();
			const envelopes: Array<Record<string, unknown>> = [];
			for (const file of files) {
				const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						envelopes.push(JSON.parse(line) as Record<string, unknown>);
					} catch {
						// corrupt line — ignore
					}
				}
			}
			return envelopes;
		},
		waitFor(fn, o = {}) {
			return waitFor(fn, { timeoutMs: o.timeoutMs ?? 4000, label: o.label });
		},
		async teardown() {
			for (const dispose of [...teardowns].reverse()) {
				try {
					await dispose();
				} catch {
					// best-effort, mirrors Cordis unload
				}
			}
			if (prevDshHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevDshHome;
			if (prevLarkHome === undefined) delete process.env.DSH_LARK_LINK_HOME;
			else process.env.DSH_LARK_LINK_HOME = prevLarkHome;
			rmSync(root, { recursive: true, force: true });
		},
	};

	return harness;
}

/** Write a `storages/workspace.json` store as the DSH GUI would. */
export function writeWorkspaceStore(
	dshHome: string,
	payload: unknown,
): void {
	mkdirSync(join(dshHome, "storages"), { recursive: true });
	writeFileSync(
		join(dshHome, "storages", "workspace.json"),
		JSON.stringify(payload, null, 2),
	);
}

/** Read a JSON file, returning undefined when absent/corrupt. */
export function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** Collect every `tag:"button"` element out of a (schema 2.0) card payload. */
export function cardButtons(card: unknown): Array<{ text?: string; op?: string }> {
	const out: Array<{ text?: string; op?: string }> = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.tag === "button") {
			const text = (record.text as { content?: string } | undefined)?.content;
			const behaviors = record.behaviors as
				| Array<{ value?: { op?: string } }>
				| undefined;
			out.push({ text, op: behaviors?.[0]?.value?.op });
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(card);
	return out;
}

/** All markdown/plain-text content of a (schema 2.0) card payload. */
export function cardText(card: unknown): string {
	const parts: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (typeof record.content === "string") parts.push(record.content);
		for (const value of Object.values(record)) walk(value);
	};
	walk(card);
	return parts.join("\n");
}

export { sleep };
