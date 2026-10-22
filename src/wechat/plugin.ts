// WeChat channel plugin — STUB.
//
// The real implementation is ported from pan17/dsh-wechat (MIT) and lands in
// this directory. This placeholder keeps the unified plugin entry compiling
// while the port is in progress; it must be replaced by the full bridge
// (login/QR, long-poll monitor, send, merge, silent/final, approval/question
// mirroring, slash commands, settings HTTP API).

export interface WechatChannelConfig {
	enabled?: boolean;
	storageDir?: string;
	[key: string]: unknown;
}

export type WechatChannelDisposer = () => void | Promise<void>;

/**
 * Start the WeChat channel on the shared Cordis context.
 *
 * Returns a disposer; the caller parks it on the plugin fiber via
 * `ctx.effect`, so unloading dsh-lark-link stops the WeChat monitor too.
 */
export function applyWechatChannel(
	_ctx: unknown,
	_config: WechatChannelConfig = {},
): WechatChannelDisposer {
	return () => {};
}
