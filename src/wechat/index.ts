// WeChat channel — public entry for the unified dsh-lark-link plugin.
//
// The WeChat implementation is ported from pan17/dsh-wechat (MIT) and kept in
// `src/wechat/**`. The unified plugin (`src/index.ts`) calls
// `applyWechatChannel(ctx, config)` from inside its own Cordis `apply`, so both
// IM channels live in one package, one profile entry and one settings page.
//
// Contract:
//   - called synchronously from dsh-lark-link's apply()
//   - must not throw for benign states (not logged in, storage missing); the
//     caller catches and logs, but a throwing apply would take Feishu down too
//   - returns a disposer (sync or async) that stops the WeChat monitor and
//     releases every registration made on `ctx`
export { applyWechatChannel, sessionIdFrom } from "./plugin.ts";
export type {
	WechatChannelConfig,
	WechatChannelDisposer,
	PluginConfig,
} from "./plugin.ts";
