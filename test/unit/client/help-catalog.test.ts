// Unified help catalog — both channel views.
//
// `src/help/catalog.ts` is the single wording source: the Feishu `/help` card,
// the WeChat `/help` listing and the WeChat settings panel all read from it.
// These tests pin that the two views stay DERIVED from the same data (a group
// id starting with `feishu-` marks the Feishu view) and that the required
// command surface of each channel is actually documented.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	catalogFor,
	channelOfEntry,
	channelOfGroup,
	feishuHelpCatalog,
	findFeishuHelpEntry,
	findHelpEntry,
	helpCatalog,
	shortestSpelling,
	type HelpCatalog,
} from "../../../src/help/catalog.ts";

function commandsOf(catalog: HelpCatalog): string[] {
	return catalog.commands.map((entry) => entry.command);
}

/** Required by the unified-bridge spec for each channel. */
const REQUIRED_FEISHU = [
	"/help",
	"/status",
	"/lark",
	"/mode",
	"/permission",
	"/model",
	"/goal",
	"/new",
	"/resume",
	"/stop",
	"/workspace",
	"/cd",
	"/ws",
	"/doctor",
	"/lark-config",
	"/sessions",
];

const REQUIRED_WECHAT = [
	"/help",
	"/status",
	"/workspace",
	"/cd",
	"/session",
	"/preset",
	"/model",
	"/perm",
	"/reasoning",
	"/enter",
	"/silent",
	"/final",
	"/merge",
	"/media",
	"/at",
	"/notify",
	"/history",
	"/flush",
	"/surface",
	"/stop",
	"/next",
	"/rq",
];

test("catalog: channel is derived from the group id (single source, two views)", () => {
	assert.equal(channelOfGroup("navigate"), "wechat");
	assert.equal(channelOfGroup("feishu-session"), "feishu");
	for (const entry of helpCatalog().commands) {
		assert.equal(channelOfEntry(entry), "wechat", entry.command);
		assert.ok(!entry.group.startsWith("feishu-"), `${entry.command} leaked into the WeChat view`);
	}
	for (const entry of feishuHelpCatalog().commands) {
		assert.equal(channelOfEntry(entry), "feishu", entry.command);
	}
});

test("catalog: every required Feishu command is documented", () => {
	const commands = commandsOf(feishuHelpCatalog());
	for (const command of REQUIRED_FEISHU) {
		assert.ok(commands.includes(command), `missing ${command}`);
	}
});

test("catalog: every required WeChat command is documented", () => {
	const commands = commandsOf(helpCatalog());
	for (const command of REQUIRED_WECHAT) {
		assert.ok(commands.includes(command), `missing ${command}`);
	}
});

test("catalog: each view declares only groups its commands use", () => {
	for (const catalog of [helpCatalog(), feishuHelpCatalog()]) {
		const groupIds = new Set(catalog.groups.map((group) => group.id));
		for (const entry of catalog.commands) {
			assert.ok(groupIds.has(entry.group), `${entry.command} → ${entry.group}`);
		}
		assert.ok(catalog.groups.length > 0);
		assert.notEqual(catalog.intro.trim(), "");
		assert.notEqual(catalog.footer.trim(), "");
	}
});

test("catalog: ids and command spellings are unique within a view", () => {
	for (const catalog of [helpCatalog(), feishuHelpCatalog()]) {
		const ids = catalog.commands.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length, "duplicate command id");
		const names = catalog.commands.map((entry) => entry.command);
		assert.equal(new Set(names).size, names.length, "duplicate command spelling");
	}
});

test("catalog: every command has a summary, usage and at least one example", () => {
	for (const catalog of [helpCatalog(), feishuHelpCatalog()]) {
		for (const entry of catalog.commands) {
			assert.notEqual(entry.summary.trim(), "", entry.command);
			assert.notEqual(entry.usage.trim(), "", entry.command);
			assert.ok(entry.examples.length > 0, entry.command);
			for (const example of entry.examples) {
				assert.notEqual(example.line.trim(), "", entry.command);
				assert.notEqual(example.note.trim(), "", `${entry.command}: ${example.line}`);
			}
		}
	}
});

test("catalog: every declared subcommand has an example (no half-documented command)", () => {
	for (const catalog of [helpCatalog(), feishuHelpCatalog()]) {
		for (const entry of catalog.commands) {
			const canonical = entry.command.replace(/^\//, "");
			const spellings = new Set([canonical, ...entry.aliases]);
			for (const sub of entry.subcommands) {
				const covered = entry.examples.some((example) => {
					const line = example.line.trim();
					if (!line.startsWith("/")) return false;
					const [rawHead, ...rest] = line.split(/\s+/);
					const name = (rawHead ?? "").replace(/^\//, "").toLowerCase();
					if (!spellings.has(name)) return false;
					const arg = rest.join(" ").toLowerCase();
					return arg === sub.toLowerCase() || arg.startsWith(`${sub.toLowerCase()} `);
				});
				assert.ok(covered, `${entry.command} has no example for "${sub}"`);
			}
		}
	}
});

test("catalog: JSON-safe (it travels over HTTP to the settings panel)", () => {
	for (const catalog of [helpCatalog(), feishuHelpCatalog()]) {
		assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
	}
});

test("catalog: snapshots are fresh — mutating a caller's copy cannot leak", () => {
	const first = helpCatalog();
	first.commands.pop();
	first.groups.length = 0;
	const second = helpCatalog();
	assert.ok(second.commands.length > 0);
	assert.ok(second.groups.length > 0);
});

test("helpCatalog(): keeps the WeChat compatibility API and the /cd alias", () => {
	assert.equal(findHelpEntry("ws")?.command, "/workspace");
	assert.equal(findHelpEntry("/SESSION")?.command, "/session");
	assert.equal(findHelpEntry("cd")?.command, "/cd");
	assert.equal(findHelpEntry("nope"), undefined);
	assert.equal(findHelpEntry(""), undefined);
	assert.equal(shortestSpelling(findHelpEntry("session")!), "/s");
});

test("feishuHelpCatalog(): lookup by any spelling, case-insensitively", () => {
	assert.equal(findFeishuHelpEntry("ws")?.command, "/ws");
	assert.equal(findFeishuHelpEntry("/CD")?.command, "/cd");
	assert.equal(findFeishuHelpEntry("lark-config")?.command, "/lark-config");
	assert.equal(findFeishuHelpEntry("nope"), undefined);
});

test("catalogFor(): returns exactly the requested channel's view", () => {
	assert.deepEqual(catalogFor("feishu"), feishuHelpCatalog());
	assert.deepEqual(catalogFor("wechat"), helpCatalog());
	for (const catalog of [catalogFor("feishu"), catalogFor("wechat")]) {
		assert.ok(catalog.commands.length > 0);
	}
});

test("catalog: the /ws entry documents every subcommand the router accepts", () => {
	const ws = findFeishuHelpEntry("ws");
	assert.ok(ws);
	for (const sub of ["list", "add", "use", "remove", "status"]) {
		assert.ok(ws.subcommands.includes(sub), `missing subcommand ${sub}`);
		assert.ok(ws.usage.includes(sub), `usage does not mention ${sub}`);
	}
});
