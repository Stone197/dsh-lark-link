// dsh-lark-link client half (browser) — ONE bundle for BOTH IM channels.
// Reusable management consoles injected into DSH Settings and Plugin Details:
//   - settings.section ('lark-link', order 25)   → LarkSettingsConsole
//   - settings.section ('wechat', order 40)      → WechatSection
//     (ported verbatim from pan17/dsh-wechat; see ./wechat-section.ts)
//   - plugins.bundle.config ('dsh-lark-link')
//   - plugins.row.config ('dsh-lark-link#lark-link')
//
// Left sidebar footer action has been removed per UX redesign.

import type { Context } from "@deepseek-ai/cordis";
import { WechatSection } from "./wechat-section.ts";

type ReactApi = {
	createElement: (
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
	useRef: <T>(initial: T) => { current: T };
};
const R = require("react") as ReactApi;
const { createElement: h, useState, useEffect, useRef } = R;

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (
		url: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string },
	) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
	confirm?: (msg: string) => boolean;
};

export const name = "dsh-lark-link-client";
export const inject = ["slots"];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: {
				name: string;
				id?: string;
				key?: string;
				order?: number;
				label?: string | (() => string);
				locale?: string;
			},
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

interface StatusPayload {
	connState?: string;
	configured?: boolean;
	outboxPending?: number;
	outboxFailed?: number;
	inboundPending?: number;
	inboundFailed?: number;
	sessions?: number;
	wsReady?: boolean;
	lastProbeOk?: boolean;
	lastProbeAt?: number;
	quarantinedUntil?: number;
	lastError?: string;
	connectedAt?: number;
	config?: {
		appId?: string;
		groupPolicy?: string;
		agentPreset?: string;
		permissionMode?: string;
		replay?: {
			auto?: boolean;
			retentionMinutes?: number;
			maxAttempts?: number;
		};
	};
}

type PanelState =
	| "loading"
	| "setup"
	| "ready"
	| "connecting"
	| "running"
	| "error";

function deriveState(s: StatusPayload | undefined): PanelState {
	if (!s) return "loading";
	if (!s.configured) return "setup";
	switch (s.connState) {
		case "connected":
			return "running";
		case "connecting":
		case "reconnecting":
			return "connecting";
		case "degraded":
		case "quarantined":
			return "error";
		default:
			return "ready";
	}
}

const STATE_CONFIG: Record<
	Exclude<PanelState, "loading">,
	{ badge: string; label: string; color: string; bg: string; border: string; desc: string }
> = {
	setup: {
		badge: "⚙️",
		label: "未配置授权",
		color: "#F59E0B",
		bg: "rgba(245,158,11,0.12)",
		border: "rgba(245,158,11,0.3)",
		desc: "使用手机飞书扫描下方二维码，或在控制台执行 /lark setup 一键接入",
	},
	ready: {
		badge: "⚪",
		label: "已授权 · 待启动",
		color: "#38BDF8",
		bg: "rgba(56,189,248,0.12)",
		border: "rgba(56,189,248,0.3)",
		desc: "飞书凭证已就绪，点击「启动桥接」或输入 /lark start 开启双向连接",
	},
	connecting: {
		badge: "🟡",
		label: "长连接建立中…",
		color: "#FBBF24",
		bg: "rgba(251,191,36,0.12)",
		border: "rgba(251,191,36,0.3)",
		desc: "正在与飞书开放平台建立 WebSocket 长连接通道",
	},
	running: {
		badge: "🟢",
		label: "运行中 · 已连接",
		color: "#10B981",
		bg: "rgba(16,185,129,0.12)",
		border: "rgba(16,185,129,0.3)",
		desc: "双向通信畅通。飞书私聊或群聊发消息即可与 DSH 智能体实时对话",
	},
	error: {
		badge: "🔴",
		label: "连接异常 / 熔断",
		color: "#EF4444",
		bg: "rgba(239,68,68,0.12)",
		border: "rgba(239,68,68,0.3)",
		desc: "连接受阻或已被配额熔断。点击「重启」或输入 /lark restart 尝试重连",
	},
};

/** Render the vector logo mark directly in JSX/h. */
function renderLogoMark(size = 38): unknown {
	return h(
		"svg",
		{
			width: size,
			height: size,
			viewBox: "0 0 48 48",
			fill: "none",
			style: { flexShrink: 0, display: "inline-block" },
		},
		h(
			"defs",
			null,
			h(
				"linearGradient",
				{ id: "lark-bg-grad-c", x1: "4", y1: "4", x2: "44", y2: "44", gradientUnits: "userSpaceOnUse" },
				h("stop", { offset: "0%", stopColor: "#0F172A", stopOpacity: "0.95" }),
				h("stop", { offset: "100%", stopColor: "#1E293B", stopOpacity: "0.98" }),
			),
			h(
				"linearGradient",
				{ id: "lark-wing-primary-c", x1: "10", y1: "10", x2: "38", y2: "28", gradientUnits: "userSpaceOnUse" },
				h("stop", { offset: "0%", stopColor: "#00F2FE" }),
				h("stop", { offset: "35%", stopColor: "#00C0FA" }),
				h("stop", { offset: "70%", stopColor: "#2563EB" }),
				h("stop", { offset: "100%", stopColor: "#1D4ED8" }),
			),
			h(
				"linearGradient",
				{ id: "lark-wing-secondary-c", x1: "14", y1: "22", x2: "36", y2: "38", gradientUnits: "userSpaceOnUse" },
				h("stop", { offset: "0%", stopColor: "#38BDF8" }),
				h("stop", { offset: "40%", stopColor: "#3B82F6" }),
				h("stop", { offset: "85%", stopColor: "#6366F1" }),
				h("stop", { offset: "100%", stopColor: "#4F46E5" }),
			),
			h(
				"linearGradient",
				{ id: "lark-link-arc-c", x1: "8", y1: "36", x2: "40", y2: "12", gradientUnits: "userSpaceOnUse" },
				h("stop", { offset: "0%", stopColor: "#10B981" }),
				h("stop", { offset: "30%", stopColor: "#00D2FF" }),
				h("stop", { offset: "70%", stopColor: "#38BDF8" }),
				h("stop", { offset: "100%", stopColor: "#818CF8" }),
			),
			h(
				"linearGradient",
				{ id: "lark-facet-sheen-c", x1: "18", y1: "8", x2: "28", y2: "26", gradientUnits: "userSpaceOnUse" },
				h("stop", { offset: "0%", stopColor: "#FFFFFF", stopOpacity: "0.8" }),
				h("stop", { offset: "50%", stopColor: "#FFFFFF", stopOpacity: "0.25" }),
				h("stop", { offset: "100%", stopColor: "#FFFFFF", stopOpacity: "0" }),
			),
		),
		h("rect", {
			x: "2",
			y: "2",
			width: "44",
			height: "44",
			rx: "11",
			fill: "url(#lark-bg-grad-c)",
			stroke: "#38BDF8",
			strokeOpacity: "0.3",
			strokeWidth: "1.2",
		}),
		h("path", {
			d: "M 12 30 C 9 20, 20 12, 34 14",
			stroke: "#38BDF8",
			strokeOpacity: "0.25",
			strokeWidth: "1.8",
			strokeDasharray: "2 3",
		}),
		h("path", {
			d: "M 11 34 L 20 25 L 14 18 L 33 13 L 26 26 L 37 29 L 23 37 Z",
			fill: "url(#lark-wing-secondary-c)",
			fillOpacity: "0.95",
		}),
		h("path", {
			d: "M 14 18 L 39 9 L 27 24 L 20 25 Z",
			fill: "url(#lark-wing-primary-c)",
		}),
		h("path", {
			d: "M 14 18 L 39 9 L 25 18 Z",
			fill: "url(#lark-facet-sheen-c)",
		}),
		h("path", {
			d: "M 10 32 C 16 38, 30 38, 38 27 C 40 24, 40 18, 39 9",
			stroke: "url(#lark-link-arc-c)",
			strokeWidth: "2.2",
			strokeLinecap: "round",
		}),
		h("circle", { cx: "10", cy: "32", r: "2.6", fill: "#00F2FE" }),
		h("circle", { cx: "10", cy: "32", r: "1.2", fill: "#FFFFFF" }),
		h("circle", { cx: "38", cy: "27", r: "2.2", fill: "#10B981" }),
		h("circle", { cx: "38", cy: "27", r: "1.0", fill: "#FFFFFF" }),
		h("circle", { cx: "39", cy: "9", r: "1.5", fill: "#FFFFFF" }),
	);
}

/**
 * Unified LarkSettingsConsole Component:
 * Reusable across Settings Section and Plugin Details View.
 */
export const LarkSettingsConsole = (props?: unknown): unknown => {
	const [status, setStatus] = useState<StatusPayload | undefined>(undefined);
	const [qrTs, setQrTs] = useState<number>(0);
	const [qrLoaded, setQrLoaded] = useState<boolean>(false);
	const [loadingAction, setLoadingAction] = useState<string | null>(null);
	const [toast, setToast] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

	// Editable runtime config values
	const [groupPolicy, setGroupPolicy] = useState<string>("mention");
	const [agentPreset, setAgentPreset] = useState<string>("ptc");
	const [permissionMode, setPermissionMode] = useState<string>("full");
	const [replayAuto, setReplayAuto] = useState<boolean>(true);

	const origin = win.location?.origin ?? "";

	const showToast = (text: string, type: "success" | "error" | "info" = "info") => {
		setToast({ text, type });
		setTimeout(() => {
			setToast((prev) => (prev?.text === text ? null : prev));
		}, 4500);
	};

	const fetchStatus = async () => {
		try {
			const res = await win.fetch?.(`${origin}/plugins/lark-link/status`);
			if (res && res.ok) {
				const data = (await res.json()) as StatusPayload;
				setStatus(data);
				if (data.config) {
					if (data.config.groupPolicy) setGroupPolicy(data.config.groupPolicy);
					if (data.config.agentPreset) setAgentPreset(data.config.agentPreset);
					if (data.config.permissionMode) setPermissionMode(data.config.permissionMode);
					if (data.config.replay?.auto !== undefined) setReplayAuto(Boolean(data.config.replay.auto));
				}
			}
		} catch {
			// keep previous state
		}
	};

	useEffect(() => {
		fetchStatus();
		const interval = setInterval(fetchStatus, 3000);
		const qrInterval = setInterval(() => setQrTs(Date.now()), 5000);
		setQrTs(Date.now());
		return () => {
			clearInterval(interval);
			clearInterval(qrInterval);
		};
	}, []);

	const postAction = async (action: string, extra?: Record<string, unknown>) => {
		setLoadingAction(action);
		try {
			const res = await win.fetch?.(`${origin}/plugins/lark-link/action`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, ...extra }),
			});
			if (res && res.ok) {
				const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
				if (json.ok) {
					showToast(json.message || "操作已完成", "success");
				} else {
					showToast(json.error || "操作未成功", "error");
				}
			} else {
				showToast("网络请求失败", "error");
			}
		} catch (err: unknown) {
			showToast(String((err as Error)?.message ?? err), "error");
		} finally {
			setLoadingAction(null);
			await fetchStatus();
		}
	};

	const handleSaveConfig = async () => {
		await postAction("updateConfig", {
			config: {
				groupPolicy,
				agentPreset,
				permissionMode,
				replay: {
					auto: replayAuto,
				},
			},
		});
	};

	const state = deriveState(status);
	const stateConf =
		state === "loading"
			? {
					badge: "…",
					label: "正在读取状态…",
					color: "#94A3B8",
					bg: "rgba(255,255,255,0.05)",
					border: "rgba(255,255,255,0.1)",
					desc: "",
				}
			: STATE_CONFIG[state];

	const isConfigured = Boolean(status?.configured);
	const showQr = state === "setup" || !isConfigured;

	// Common button styles
	const btnStyle = (variant: "primary" | "secondary" | "danger" = "secondary") => ({
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
		padding: "7px 14px",
		borderRadius: "8px",
		fontSize: "12.5px",
		fontWeight: 600,
		cursor: loadingAction ? "not-allowed" : "pointer",
		opacity: loadingAction ? 0.6 : 1,
		transition: "all 0.15s ease",
		border:
			variant === "primary"
				? "1px solid #38BDF8"
				: variant === "danger"
					? "1px solid rgba(239,68,68,0.5)"
					: "1px solid rgba(255,255,255,0.16)",
		background:
			variant === "primary"
				? "linear-gradient(135deg, #0284C7 0%, #0369A1 100%)"
				: variant === "danger"
					? "rgba(239,68,68,0.15)"
					: "rgba(255,255,255,0.06)",
		color:
			variant === "primary"
				? "#FFFFFF"
				: variant === "danger"
					? "#FCA5A5"
					: "#E2E8F0",
	});

	const cardStyle = {
		background: "rgba(255,255,255,0.03)",
		border: "1px solid rgba(255,255,255,0.08)",
		borderRadius: "12px",
		padding: "16px 20px",
		marginBottom: "16px",
	};

	return h(
		"div",
		{
			style: {
				maxWidth: "840px",
				margin: "0 auto",
				color: "#E2E8F0",
				fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
				fontSize: "13px",
				lineHeight: "1.6",
				padding: "16px 8px",
			},
		},
		// Toast banner
		toast
			? h(
					"div",
					{
						style: {
							position: "sticky",
							top: "8px",
							zIndex: 100,
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							padding: "10px 16px",
							borderRadius: "8px",
							marginBottom: "12px",
							fontSize: "13px",
							fontWeight: 500,
							background:
								toast.type === "success"
									? "rgba(16,185,129,0.92)"
									: toast.type === "error"
										? "rgba(239,68,68,0.92)"
										: "rgba(56,189,248,0.92)",
							color: "#FFFFFF",
							boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
						},
					},
					h("span", null, toast.text),
					h(
						"button",
						{
							type: "button",
							onClick: () => setToast(null),
							style: { background: "transparent", border: "none", color: "#FFFFFF", cursor: "pointer", fontSize: "14px" },
						},
						"✕",
					),
				)
			: null,

		// Top Header Bar
		h(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					flexWrap: "wrap",
					gap: "14px",
					paddingBottom: "16px",
					borderBottom: "1px solid rgba(255,255,255,0.1)",
					marginBottom: "20px",
				},
			},
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "12px" } },
				renderLogoMark(42),
				h(
					"div",
					null,
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "8px" } },
						h("h2", { style: { margin: 0, fontSize: "18px", fontWeight: 700, color: "#FFFFFF" } }, "Lark Link"),
						h(
							"span",
							{
								style: {
									fontSize: "11px",
									fontWeight: 600,
									padding: "2px 7px",
									borderRadius: "12px",
									background: "rgba(56,189,248,0.15)",
									color: "#38BDF8",
									border: "1px solid rgba(56,189,248,0.25)",
								},
							},
							"v0.6.0",
						),
						h(
							"span",
							{
								style: {
									fontSize: "11px",
									fontWeight: 500,
									padding: "2px 7px",
									borderRadius: "12px",
									background: "rgba(255,255,255,0.06)",
									color: "#94A3B8",
								},
							},
							"MIT",
						),
					),
					h(
						"div",
						{ style: { fontSize: "12px", color: "#94A3B8", marginTop: "2px" } },
						"DeepSeek Harness × 飞书/Lark 双向高可靠通信桥接",
					),
				),
			),
			// Action controls in header
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
				h(
					"button",
					{
						type: "button",
						style: btnStyle("secondary"),
						onClick: () => fetchStatus(),
						title: "刷新桥接状态",
					},
					"🔄 刷新",
				),
				state === "running"
					? h(
							"button",
							{
								type: "button",
								style: btnStyle("danger"),
								onClick: () => postAction("stop"),
								title: "暂停飞书桥接长连接",
							},
							"⏸ 停止",
						)
					: null,
				state === "running"
					? h(
							"button",
							{
								type: "button",
								style: btnStyle("secondary"),
								onClick: () => postAction("restart"),
								title: "重新建立连接",
							},
							"🔁 重启",
						)
					: null,
				state === "ready"
					? h(
							"button",
							{
								type: "button",
								style: btnStyle("primary"),
								onClick: () => postAction("start"),
								title: "启动长连接桥接",
							},
							"▶ 启动桥接",
						)
					: null,
				!isConfigured
					? h(
							"button",
							{
								type: "button",
								style: btnStyle("primary"),
								onClick: () => postAction("setup"),
								title: "生成一键接入二维码",
							},
							"📲 扫码授权",
						)
					: null,
			),
		),

		// Status Banner
		h(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					gap: "12px",
					padding: "14px 18px",
					background: stateConf.bg,
					border: `1px solid ${stateConf.border}`,
					borderRadius: "10px",
					marginBottom: "20px",
					color: stateConf.color,
				},
			},
			h("span", { style: { fontSize: "20px" } }, stateConf.badge),
			h(
				"div",
				{ style: { flex: 1 } },
				h("div", { style: { fontWeight: 700, fontSize: "14px" } }, stateConf.label),
				h("div", { style: { fontSize: "12px", opacity: 0.9, marginTop: "2px" } }, stateConf.desc),
			),
			status?.connectedAt
				? h(
						"div",
						{
							style: {
								fontSize: "11px",
								opacity: 0.8,
								textAlign: "right",
								fontFamily: "ui-monospace, monospace",
							},
						},
						`连接时间: ${new Date(status.connectedAt).toLocaleTimeString()}`,
					)
				: null,
		),

		// Metrics 4-Grid Card
		h(
			"div",
			{
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: "12px",
					marginBottom: "20px",
				},
			},
			// Metric 1: Connection
			h(
				"div",
				{ style: cardStyle },
				h("div", { style: { color: "#94A3B8", fontSize: "11.5px", fontWeight: 600 } }, "📡 长连接状态"),
				h(
					"div",
					{ style: { fontSize: "16px", fontWeight: 700, marginTop: "6px", color: "#FFFFFF" } },
					status?.connState?.toUpperCase() || "IDLE",
				),
				h(
					"div",
					{ style: { fontSize: "11px", color: "#94A3B8", marginTop: "4px" } },
					`WS 就绪: ${status?.wsReady ? "✅ 是" : "⚪ 否"} · 探活: ${status?.lastProbeOk ? "正常" : "—"}`,
				),
			),
			// Metric 2: Outbox
			h(
				"div",
				{ style: cardStyle },
				h("div", { style: { color: "#94A3B8", fontSize: "11.5px", fontWeight: 600 } }, "📬 零丢失 Outbox"),
				h(
					"div",
					{ style: { fontSize: "16px", fontWeight: 700, marginTop: "6px", color: "#38BDF8" } },
					`${status?.outboxPending ?? 0} 待发`,
				),
				h(
					"div",
					{ style: { fontSize: "11px", color: "#94A3B8", marginTop: "4px" } },
					`失败离队: ${status?.outboxFailed ?? 0} 条 · 磁盘持久化`,
				),
			),
			// Metric 3: Inbound WAL
			h(
				"div",
				{ style: cardStyle },
				h("div", { style: { color: "#94A3B8", fontSize: "11.5px", fontWeight: 600 } }, "📥 入站请求 WAL"),
				h(
					"div",
					{ style: { fontSize: "16px", fontWeight: 700, marginTop: "6px", color: "#10B981" } },
					`${status?.inboundPending ?? 0} 待补发`,
				),
				h(
					"div",
					{ style: { fontSize: "11px", color: "#94A3B8", marginTop: "4px" } },
					`失败: ${status?.inboundFailed ?? 0} · 自动补发: ${status?.config?.replay?.auto ? "开" : "关"}`,
				),
			),
			// Metric 4: Sessions
			h(
				"div",
				{ style: cardStyle },
				h("div", { style: { color: "#94A3B8", fontSize: "11.5px", fontWeight: 600 } }, "💬 活跃会话"),
				h(
					"div",
					{ style: { fontSize: "16px", fontWeight: 700, marginTop: "6px", color: "#FFFFFF" } },
					`${status?.sessions ?? 0} 个会话`,
				),
				h(
					"div",
					{ style: { fontSize: "11px", color: "#94A3B8", marginTop: "4px" } },
					"DSH 原生会话隔离",
				),
			),
		),

		// Section: Setup & Authentication
		showQr
			? h(
					"div",
					{ style: cardStyle },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" } },
						h("span", { style: { fontSize: "16px" } }, "📲"),
						h("strong", { style: { fontSize: "14px", color: "#FFFFFF" } }, "飞书应用一键配置 (QR 快速接入)"),
					),
					h(
						"p",
						{ style: { color: "#94A3B8", fontSize: "12px", margin: "0 0 14px 0" } },
						"使用手机飞书扫描下方二维码即可 10 秒自动创建飞书应用并授权免配密钥。若未显示二维码，可点击「重新生成二维码」。",
					),
					h(
						"div",
						{ style: { textAlign: "center", padding: "16px 0" } },
						h("img", {
							src: `${origin}/plugins/lark-link/qr?t=${qrTs}`,
							alt: "Lark Link Setup QR",
							onError: () => setQrLoaded(false),
							onLoad: () => setQrLoaded(true),
							style: {
								width: "220px",
								height: "220px",
								borderRadius: "10px",
								border: "1px solid rgba(255,255,255,0.15)",
								background: "#FFFFFF",
								padding: "8px",
								display: qrLoaded ? "inline-block" : "none",
								boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
							},
						}),
						!qrLoaded
							? h(
									"div",
									{
										style: {
											padding: "24px 16px",
											background: "rgba(255,255,255,0.02)",
											borderRadius: "8px",
											border: "1px dashed rgba(255,255,255,0.15)",
											maxWidth: "360px",
											margin: "0 auto",
										},
									},
									h("div", { style: { marginBottom: "8px", color: "#94A3B8" } }, "正在生成配置二维码…"),
									h(
										"button",
										{
											type: "button",
											style: btnStyle("primary"),
											onClick: () => postAction("setup"),
										},
										"立即触发 /lark setup",
									),
								)
							: null,
					),
				)
			: h(
					"div",
					{ style: cardStyle },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
						h(
							"div",
							null,
							h("strong", { style: { color: "#FFFFFF", fontSize: "13.5px" } }, "✅ 飞书应用授权已绑定"),
							h(
								"div",
								{ style: { fontSize: "12px", color: "#94A3B8", marginTop: "3px" } },
								status?.config?.appId ? `已授权 App ID: ${status.config.appId}` : "凭证存储于 ~/.dsh/.credentials.yaml",
							),
						),
						h(
							"div",
							{ style: { display: "flex", gap: "8px" } },
							h(
								"button",
								{
									type: "button",
									style: btnStyle("secondary"),
									onClick: () => postAction("setup"),
								},
								"重新扫码授权",
							),
							h(
								"button",
								{
									type: "button",
									style: btnStyle("danger"),
									onClick: () => {
										if (win.confirm?.("确定彻底清除飞书应用绑定与凭据吗？")) {
											void postAction("uninstall-clean");
										}
									},
								},
								"清除配置 (Uninstall)",
							),
						),
					),
				),

		// Section: Runtime Bridge Configuration
		h(
			"div",
			{ style: cardStyle },
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("span", { style: { fontSize: "16px" } }, "⚙️"),
					h("strong", { style: { fontSize: "14px", color: "#FFFFFF" } }, "桥接运行配置 (Runtime Policy)"),
				),
				h(
					"button",
					{
						type: "button",
						style: btnStyle("primary"),
						onClick: handleSaveConfig,
					},
					"💾 保存实时配置",
				),
			),

			h(
				"div",
				{ style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" } },
				// Field 1: Group Policy
				h(
					"div",
					null,
					h("label", { style: { display: "block", fontWeight: 600, color: "#CBD5E1", marginBottom: "6px" } }, "群聊触发策略 (Group Policy)"),
					h(
						"select",
						{
							value: groupPolicy,
							onChange: (e: { target: { value: string } }) => setGroupPolicy(e.target.value),
							style: {
								width: "100%",
								padding: "8px 12px",
								borderRadius: "8px",
								background: "rgba(15,23,42,0.8)",
								border: "1px solid rgba(255,255,255,0.18)",
								color: "#FFFFFF",
								fontSize: "12.5px",
							},
						},
						h("option", { value: "mention" }, "@ 机器人触发 (mention - 推荐)"),
						h("option", { value: "open" }, "全自由触发 (open - 群聊免 @)"),
						h("option", { value: "reply" }, "回复机器人消息触发 (reply)"),
						h("option", { value: "keywords" }, "关键词唤醒触发 (keywords)"),
					),
					h("span", { style: { fontSize: "11px", color: "#94A3B8" } }, "控制在飞书群聊中机器人的激活条件"),
				),

				// Field 2: Agent Preset
				h(
					"div",
					null,
					h("label", { style: { display: "block", fontWeight: 600, color: "#CBD5E1", marginBottom: "6px" } }, "默认智能体预设 (Agent Preset)"),
					h(
						"select",
						{
							value: agentPreset,
							onChange: (e: { target: { value: string } }) => setAgentPreset(e.target.value),
							style: {
								width: "100%",
								padding: "8px 12px",
								borderRadius: "8px",
								background: "rgba(15,23,42,0.8)",
								border: "1px solid rgba(255,255,255,0.18)",
								color: "#FFFFFF",
								fontSize: "12.5px",
							},
						},
						h("option", { value: "ptc" }, "PTC 专家模式 (ptc - 默认高精度)"),
						h("option", { value: "standard" }, "标准模式 (standard)"),
						h("option", { value: "minimal" }, "极简对话模式 (minimal)"),
						h("option", { value: "creator" }, "创作者模式 (creator)"),
					),
					h("span", { style: { fontSize: "11px", color: "#94A3B8" } }, "新建飞书会话默认加载的 DSH Agent 预设"),
				),

				// Field 3: Permission Mode
				h(
					"div",
					null,
					h("label", { style: { display: "block", fontWeight: 600, color: "#CBD5E1", marginBottom: "6px" } }, "权限执行策略 (Permission Mode)"),
					h(
						"select",
						{
							value: permissionMode,
							onChange: (e: { target: { value: string } }) => setPermissionMode(e.target.value),
							style: {
								width: "100%",
								padding: "8px 12px",
								borderRadius: "8px",
								background: "rgba(15,23,42,0.8)",
								border: "1px solid rgba(255,255,255,0.18)",
								color: "#FFFFFF",
								fontSize: "12.5px",
							},
						},
						h("option", { value: "full" }, "Full Access (开箱全放行 - 推荐)"),
						h("option", { value: "workspace-only" }, "仅限工作区读写 (workspace-only)"),
						h("option", { value: "confirm-tools" }, "危险工具逐项卡片确认 (confirm-tools)"),
					),
					h("span", { style: { fontSize: "11px", color: "#94A3B8" } }, "限制会话内工具执行权限与审批交互"),
				),

				// Field 4: Inbound Replay Switch
				h(
					"div",
					null,
					h("label", { style: { display: "block", fontWeight: 600, color: "#CBD5E1", marginBottom: "6px" } }, "入站请求自动补发 (Inbound Replay)"),
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" } },
						h(
							"button",
							{
								type: "button",
								style: {
									...btnStyle(replayAuto ? "primary" : "secondary"),
									padding: "6px 16px",
								},
								onClick: () => setReplayAuto((v) => !v),
							},
							replayAuto ? "✅ 自动补发: 开启" : "⚪ 自动补发: 关闭",
						),
						h(
							"button",
							{
								type: "button",
								style: btnStyle("secondary"),
								onClick: () => postAction("replay"),
							},
							"⚡ 立即补发 WAL",
						),
					),
					h("span", { style: { fontSize: "11px", color: "#94A3B8", marginTop: "4px", display: "inline-block" } }, "崩溃或重启后自动重新派发未完成消息"),
				),
			),
		),

		// Section: Quick Command Cheat Sheet
		h(
			"div",
			{ style: cardStyle },
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" } },
				h("span", { style: { fontSize: "16px" } }, "💡"),
				h("strong", { style: { fontSize: "14px", color: "#FFFFFF" } }, "常用飞书 / DSH 斜杠命令速查"),
			),
			h(
				"div",
				{
					style: {
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
						gap: "10px",
						fontFamily: "ui-monospace, monospace",
						fontSize: "12px",
					},
				},
				[
					{ cmd: "/lark start", desc: "启动桥接长连接通道" },
					{ cmd: "/lark stop", desc: "停止长连接并释放资源" },
					{ cmd: "/lark restart", desc: "重置并重新建立连接" },
					{ cmd: "/lark status", desc: "查看完整链路健康状态" },
					{ cmd: "/lark replay", desc: "手动触发未投递 WAL 补发" },
					{ cmd: "/mode", desc: "弹出卡片一键切换 Agent 预设" },
					{ cmd: "/permission", desc: "弹出卡片切换执行权限级别" },
					{ cmd: "/doctor", desc: "打包全链路日志与诊断 ZIP" },
					{ cmd: "/workspace <路径>", desc: "切换当前群聊绑定工作区" },
					{ cmd: "/goal <任务>", desc: "开启长任务 Goal 自驱动看板" },
				].map((item) =>
					h(
						"div",
						{
							key: item.cmd,
							style: {
								padding: "8px 10px",
								borderRadius: "6px",
								background: "rgba(255,255,255,0.02)",
								border: "1px solid rgba(255,255,255,0.06)",
							},
						},
						h("div", { style: { color: "#38BDF8", fontWeight: 700 } }, item.cmd),
						h("div", { style: { color: "#94A3B8", fontSize: "11px", marginTop: "2px" } }, item.desc),
					),
				),
			),
		),
	);
};

export function apply(ctx: ClientContext): void {
	// 1. Settings section: inject under DSH Settings -> Lark / 飞书
	ctx.slots.inject("settings.section", () => {
		const dispose = ctx.slots.register(
			{
				name: "settings.section",
				id: "lark-link",
				order: 25,
				label: () => "Lark / 飞书",
			},
			LarkSettingsConsole,
		);
		return dispose;
	});

	// 2. Plugins detail page: sidebar -> 插件 -> dsh-lark-link detail panel
	// Reuses the identical LarkSettingsConsole for 100% parity
	ctx.slots.inject("plugins.bundle.config", () => {
		const dispose = ctx.slots.register(
			{ name: "plugins.bundle.config", key: "dsh-lark-link" },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === "summary") return null;
				return h(LarkSettingsConsole, { isModal: false });
			},
		);
		return dispose;
	});

	// 3. Plugins row config: row clickthrough
	ctx.slots.inject("plugins.row.config", () => {
		const dispose = ctx.slots.register(
			{ name: "plugins.row.config", key: "dsh-lark-link#lark-link" },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === "summary") return null;
				return h(LarkSettingsConsole, { isModal: false });
			},
		);
		return dispose;
	});

	// 4. Settings section: WeChat panel (order 40), ported from dsh-wechat.
	// Park the registration on the plugin's fiber: dropping the disposer leaves
	// the panel registered after unload, and re-registering on the next load
	// would stack a duplicate entry. `ctx.effect` is the documented owner; the
	// plain call stays as a fallback for an older client kernel.
	const register = () =>
		ctx.slots.inject("settings.section", () => {
			const dispose = ctx.slots.register(
				{
					name: "settings.section",
					id: "wechat",
					order: 40,
					label: "WeChat",
				},
				WechatSection,
			);
			return dispose;
		});
	if (ctx.effect) {
		// @ts-expect-error — this client-side `slots.inject` is typed void while
		// the kernel's effect body may return a disposer; the runtime shapes
		// match (both hand back the slot disposer).
		ctx.effect(register);
	} else {
		register();
	}
}
