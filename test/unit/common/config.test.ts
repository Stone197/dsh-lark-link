import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  deepMerge,
  createConfigStore,
  DEFAULT_CONFIG,
  HOT_RELOADABLE,
  buildHotReloadPatch,
  normalizeAgentPreset,
  SHIPPED_AGENT_PRESET_IDS,
} from "../../../src/common/config.ts";

test("config: defaults deep-merge with partial overrides", () => {
  const merged = deepMerge(DEFAULT_CONFIG, { groupPolicy: "open", streaming: { enabled: false, printFrequencyMs: 120, printStep: 3 } });
  assert.equal(merged.groupPolicy, "open");
  assert.equal(merged.streaming.enabled, false);
  assert.equal(merged.streaming.printFrequencyMs, DEFAULT_CONFIG.streaming.printFrequencyMs);
  assert.equal(merged.denyList.length, 0);
});

// GH #11: default agentPreset must be a DSH-shipped id — `code` is not one.
test("config: default agentPreset is a DSH-shipped id (not historical alias `code`)", () => {
  assert.equal(DEFAULT_CONFIG.agentPreset, "ptc");
  assert.ok(
    SHIPPED_AGENT_PRESET_IDS.includes(DEFAULT_CONFIG.agentPreset),
    `default agentPreset must be in ${SHIPPED_AGENT_PRESET_IDS.join("|")}`,
  );
  assert.ok(!SHIPPED_AGENT_PRESET_IDS.includes("code"));
});

test("config: normalizeAgentPreset maps historical code → ptc and leaves others alone", () => {
  assert.equal(normalizeAgentPreset("code"), "ptc");
  assert.equal(normalizeAgentPreset("ptc"), "ptc");
  assert.equal(normalizeAgentPreset("standard"), "standard");
  assert.equal(normalizeAgentPreset("minimal"), "minimal");
  assert.equal(normalizeAgentPreset("cordis"), "cordis");
  assert.equal(normalizeAgentPreset("my-custom"), "my-custom");
});

test("config: hot reload only allows whitelisted keys", () => {
  const store = createConfigStore("/tmp/dsh-lark-config-test-1");
  store.update({ groupPolicy: "keywords" });
  assert.equal(store.get().groupPolicy, "keywords");
  assert.throws(() => store.update({ credentialRef: "hack" as never }));
});

test("config: overrides persist to disk and reload", () => {
  const store = createConfigStore("/tmp/dsh-lark-config-test-2");
  store.update({ denyList: ["rm -rf /"] });
  store.saveOverrides();
  const reloaded = createConfigStore("/tmp/dsh-lark-config-test-2");
  assert.deepEqual(reloaded.get().denyList, ["rm -rf /"]);
});

test("config: hot-reloadable keys cover the documented set", () => {
  for (const key of ["groupPolicy", "groupKeywords", "alsoOnReply", "streaming", "reactions", "denyList", "allowlist"]) {
    assert.ok(HOT_RELOADABLE.includes(key as never), `${key} should be hot-reloadable`);
  }
});

// ---- dotted-path hot reload (streaming.enabled bug) -------------------------
// /lark-config streaming.enabled=true used to answer "不可热改" — the handler
// only matched TOP-LEVEL whitelist keys and never parsed the dotted path.

test("config: buildHotReloadPatch resolves dotted paths under whitelisted keys", () => {
  const patch = buildHotReloadPatch("streaming.enabled", true);
  assert.deepEqual(patch, { streaming: { enabled: true } });
  const store = createConfigStore("/tmp/dsh-lark-config-test-3");
  store.update(patch);
  assert.equal(store.get().streaming.enabled, true);
  assert.equal(store.get().streaming.printFrequencyMs, DEFAULT_CONFIG.streaming.printFrequencyMs);
});

test("config: buildHotReloadPatch accepts top-level whitelist keys verbatim", () => {
  assert.deepEqual(buildHotReloadPatch("groupPolicy", "open"), { groupPolicy: "open" });
  assert.deepEqual(buildHotReloadPatch("denyList", ["x"]), { denyList: ["x"] });
});

test("config: buildHotReloadPatch rejects non-whitelisted top-level segments", () => {
  assert.throws(() => buildHotReloadPatch("credentialRef", "hack"), /不可热改|not hot-reloadable/);
  assert.throws(() => buildHotReloadPatch("evil.enabled", 1), /不可热改|not hot-reloadable/);
});

test("config: buildHotReloadPatch rejects unknown nested keys", () => {
  assert.throws(() => buildHotReloadPatch("streaming.nope", 1), /未知|unknown/i);
  // object-typed keys only take dotted paths one level deep per schema
  assert.throws(() => buildHotReloadPatch("streaming.enabled.deeper", 1), /未知|unknown|对象/i);
});

// ---- attachments (inbound media: temp dir + retention) ------------------------

test("buildHotReloadPatch: attachments.retentionHours is hot-reloadable", () => {
	const patch = buildHotReloadPatch("attachments.retentionHours", 48);
	assert.deepEqual(patch, { attachments: { retentionHours: 48 } });
});

test("buildHotReloadPatch: unknown attachments sub-key still throws", () => {
	assert.throws(
		() => buildHotReloadPatch("attachments.nope", 1),
		/config key "attachments.nope" is unknown/,
	);
});

test("attachments default retention is 7 days (168h) — survives multi-day sessions on any OS", () => {
	assert.equal(DEFAULT_CONFIG.attachments.retentionHours, 168);
	assert.equal(DEFAULT_CONFIG.attachments.dir, "", "empty dir = OS temp dir default");
});

// ---- GH #14: replay switches ------------------------------------------------

test("config: replay defaults preserve zero-loss auto-replay (30min window, 2 attempts)", () => {
	assert.deepEqual(DEFAULT_CONFIG.replay, {
		auto: true,
		retentionMinutes: 30,
		maxAttempts: 2,
	});
	assert.ok(HOT_RELOADABLE.includes("replay"), "replay is hot-reloadable");
});

test("config: /lark-config replay.auto=false patches the nested key without losing siblings", () => {
	const patch = buildHotReloadPatch("replay.auto", false);
	assert.deepEqual(patch, { replay: { auto: false } });
	const store = createConfigStore(
		join(process.env.TMPDIR ?? "/tmp", `cfg-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`),
	);
	store.update(patch);
	store.saveOverrides();
	const cfg = store.get();
	assert.equal(cfg.replay.auto, false);
	assert.equal(cfg.replay.retentionMinutes, 30, "siblings preserved by deep merge");
	assert.equal(cfg.replay.maxAttempts, 2);
});

test("config: autoReplayEnabled honors env DSH_LARK_AUTO_REPLAY over config", async () => {
	const { autoReplayEnabled } = await import("../../../src/common/config.ts");
	const prev = process.env.DSH_LARK_AUTO_REPLAY;
	try {
		delete process.env.DSH_LARK_AUTO_REPLAY;
		assert.equal(autoReplayEnabled(true), true, "unset → config value");
		assert.equal(autoReplayEnabled(false), false);
		process.env.DSH_LARK_AUTO_REPLAY = "0";
		assert.equal(autoReplayEnabled(true), false, "env 0 wins over config true");
		process.env.DSH_LARK_AUTO_REPLAY = "off";
		assert.equal(autoReplayEnabled(true), false);
		process.env.DSH_LARK_AUTO_REPLAY = "1";
		assert.equal(autoReplayEnabled(false), true, "env 1 forces on");
	} finally {
		if (prev === undefined) delete process.env.DSH_LARK_AUTO_REPLAY;
		else process.env.DSH_LARK_AUTO_REPLAY = prev;
	}
});
