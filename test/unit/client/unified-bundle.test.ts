// The unified client bundle — static wiring guards.
//
// tsdown builds ONE browser bundle from src/client/index.ts. Both IM channels
// must be registered from it (the whole point of the unified bridge): the
// Feishu console at order 25 and the migrated WeChat panel at order 40, while
// the plugin-detail registrations keep working. These assertions read the
// source (always available) and dist/client.js when a build has been produced
// (so a local `pnpm run build` is verified, not just the config).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);

function readSource(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, root)), "utf8");
}

const clientEntry = readSource("src/client/index.ts");
const wechatSection = readSource("src/client/wechat-section.ts");
const wechatHelpers = readSource("src/client/wechat-helpers.ts");
const allClientSources = [clientEntry, wechatSection, wechatHelpers].join("\n");

test("client entry registers BOTH settings sections from one bundle", () => {
	assert.match(clientEntry, /ctx\.slots\.inject\("settings\.section"/);
	assert.match(clientEntry, /id: "lark-link"/);
	assert.match(clientEntry, /order: 25/);
	assert.match(clientEntry, /id: "wechat"/);
	assert.match(clientEntry, /order: 40/);
	// The label is the literal the settings panel shows; keep it stable.
	assert.match(clientEntry, /label: "WeChat"/);
	// Park the WeChat registration on the plugin fiber (unload-safe).
	assert.match(clientEntry, /ctx\.effect\(register\)/);
});

test("client entry keeps the plugins detail-page registrations", () => {
	assert.match(clientEntry, /plugins\.bundle\.config/);
	assert.match(clientEntry, /plugins\.row\.config/);
	assert.match(clientEntry, /dsh-lark-link#lark-link/);
});

test("WeChat panel keeps the /wechat/api prefix and the e2e anchors", () => {
	// HTTP prefix contract with the host-side WeChat channel.
	assert.match(wechatHelpers, /\/wechat\/api\$\{path\}/);
	// QR login, session actions, collapse state, help sheet.
	assert.match(wechatSection, /run\("\/relogin"\)/);
	assert.match(wechatSection, /run\("\/logout"\)/);
	assert.match(wechatSection, /\/wechat\/api\/qr-image/);
	assert.match(wechatHelpers, /dsh-wechat\/settings-open/);
	assert.match(wechatHelpers, /dsh-wechat\/help-open/);
	assert.match(wechatSection, /body\.catalog/);
	assert.match(wechatSection, /wx_help_sheet/);
	assert.match(wechatSection, /wx_help_retry/);
	// Save payload is the same mapping the panel tests pin.
	assert.match(wechatHelpers, /export function payloadOf/);
	assert.match(wechatHelpers, /sendWechatRateLimitPerMinute/);
	assert.match(wechatHelpers, /allowRemotePermissionEscalation/);
	// The migrated module must not reach into Feishu modules.
	assert.ok(!allClientSources.includes("../outbound/"));
	assert.ok(!allClientSources.includes("../index.ts"));
});

test("dist/client.js ships both sections when a build exists", { skip: !existsSync(fileURLToPath(new URL("dist/client.js", root))) }, () => {
	const bundle = readSource("dist/client.js");
	assert.match(bundle, /window\.__ModuleLoader__\.load/);
	assert.match(bundle, /id: "lark-link"/);
	assert.match(bundle, /id: "wechat"/);
	assert.match(bundle, /order: 25/);
	assert.match(bundle, /order: 40/);
	assert.match(bundle, /label: "WeChat"/);
	assert.match(bundle, /wx_section/);
});
