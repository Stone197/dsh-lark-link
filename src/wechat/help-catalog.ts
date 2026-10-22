// Ported from pan17/dsh-wechat v0.13.3 (MIT) — WeChat channel of the
// unified dsh-lark-link plugin.
/**
 * WeChat view of the shared command-help catalog.
 *
 * The catalog itself is NOT copied here: the unified plugin keeps ONE source of
 * every user-facing help string in `src/help/catalog.ts`, because both channels'
 * `/help` and the single settings console must never disagree about which
 * commands exist. This module is the channel-internal import surface
 * (`src/wechat/bridge/slash.ts`, the `/wechat/api/help` route), so the ported
 * WeChat code keeps importing `./help-catalog.js` exactly as in dsh-wechat.
 *
 * The re-exported API is shape- and name-identical to the standalone
 * dsh-wechat module:
 *
 *   helpCatalog(): HelpCatalog          — the WeChat view (groups/commands/
 *                                         intro/footer, JSON-safe)
 *   findHelpEntry(topic)                — `/help <命令>` lookup by name/alias
 *   shortestSpelling(entry)             — `/s` style shortest spelling
 *   HelpCatalog / HelpGroup / HelpCommandEntry / HelpExample / HelpGroupId
 *
 * The unified catalog also carries the Feishu view (`feishuHelpCatalog()`) and
 * channel helpers; `helpCatalog()` remains the WeChat entry point, so the
 * `/wechat/api/help` response shape is unchanged.
 */
export * from "../help/catalog.ts";
