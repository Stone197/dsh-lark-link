import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
	projectKeyOf,
	decodeSessionDirName,
	encodeSessionDirName,
	normalizeSessionHeader,
	parseGenerationLogFilename,
	findSessionLogFile,
	readSessionLogJsonl,
	listWorkspaceSessions,
	extractTitleFromEvents,
	createSavedWorkspaceStore,
	defaultWorkspacesFile,
	findSavedWorkspace,
	normalizeWorkspacePath,
	sameWorkspacePath,
} from "../../../src/sessions/workspace-sessions.ts";


// ---- projectKeyOf (DSH persistence 的目录编码，必须逐字对齐) -----------------

test("projectKey: matches the DSH session persistence encoding", () => {
	assert.equal(projectKeyOf("/home/zand/proj"), "--home-zand-proj--");
	assert.equal(projectKeyOf("/home/zand"), "--home-zand--");
	// 真实样本：~/.dsh/sessions/--home-zand-proj-dsh-lark-link--
	assert.equal(
		projectKeyOf("/home/zand/proj/dsh-lark-link"),
		"--home-zand-proj-dsh-lark-link--",
	);
});

test("projectKey: consecutive separators collapse; empty readable → root", () => {
	assert.equal(projectKeyOf("//a///b"), "--a-b--");
	assert.equal(projectKeyOf("///"), "--root--");
});

test("projectKey: windows drive and UNC paths encode separators the same way", () => {
	assert.equal(projectKeyOf("D:\\Users\\kitti\\ws"), "--D-Users-kitti-ws--");
	assert.equal(projectKeyOf("\\\\server\\share"), "--server-share--");
});

test("projectKey: unsafe characters use the ~XXXX escape", () => {
	// 空格 (0x20) → ~0020
	assert.equal(projectKeyOf("/a b"), "--a~0020b--");
});

// ---- decodeSessionDirName ----------------------------------------------------

test("decode: ~003A decodes back to ':' (lark-link session ids)", () => {
	assert.equal(
		decodeSessionDirName("lark-link~003Adm~003Aoc_x~003Anonce~003A0"),
		"lark-link:dm:oc_x:nonce:0",
	);
});

test("decode: plain names and literal tildes survive", () => {
	assert.equal(decodeSessionDirName("abc-123"), "abc-123");
	assert.equal(decodeSessionDirName("7c9e067f-1234"), "7c9e067f-1234");
});

// ---- listWorkspaceSessions: persistence-service source ------------------------

test("list: service source filters by cwd, excludes subagents, sorts desc", async () => {
	const persistence = {
		async list() {
			return [
				{
					id: "gui-newer",
					createdAt: 3000,
					cwd: "/ws/proj",
					agentPreset: "ptc",
				},
				{
					id: "gui-older",
					createdAt: 1000,
					cwd: "/ws/proj",
					agentPreset: "standard",
				},
				{ id: "other-ws", createdAt: 5000, cwd: "/elsewhere" },
				{
					id: "sub-agent",
					createdAt: 4000,
					cwd: "/ws/proj",
					origin: "subagent",
				},
				{ id: "excluded-current", createdAt: 2000, cwd: "/ws/proj" },
			];
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
		exclude: ["excluded-current"],
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["gui-newer", "gui-older"],
	);
	assert.equal(rows[0]!.preset, "ptc");
	assert.equal(rows[0]!.source, "service");
});

test("list: service source caps to limit", async () => {
	const persistence = {
		async list() {
			return Array.from({ length: 25 }, (_, i) => ({
				id: `s${i}`,
				createdAt: i,
				cwd: "/ws/proj",
			}));
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
		limit: 10,
	});
	assert.equal(rows.length, 10);
	assert.equal(rows[0]!.id, "s24", "newest first");
});

// ---- listWorkspaceSessions: filesystem-scan fallback --------------------------

test("list: scan fallback reads the workspace project dir, decodes ids, sorts by mtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-ws-list-"));
	const dir = join(root, projectKeyOf("/ws/proj"));
	mkdirSync(join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0"), {
		recursive: true,
	});
	mkdirSync(join(dir, "gui-uuid-2"), { recursive: true });
	mkdirSync(join(dir, "empty-no-log"), { recursive: true }); // 无日志 → 跳过
	// 另一个工作区（不该出现）
	mkdirSync(join(root, projectKeyOf("/other"), "stranger"), { recursive: true });
	writeFileSync(
		join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0", "session.jsonl.zstd"),
		"x",
	);
	writeFileSync(join(dir, "gui-uuid-2", "session.jsonl.zstd"), "x");
	writeFileSync(join(root, projectKeyOf("/other"), "stranger", "session.jsonl.zstd"), "x");
	// mtime: gui-uuid-2 更新 → 排最前
	const now = Date.now();
	const f1 = join(dir, "gui-uuid-2", "session.jsonl.zstd");
	const f2 = join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0", "session.jsonl.zstd");
	await new Promise((r) => setTimeout(r, 20));
	writeFileSync(f1, "newer");

	const rows = await listWorkspaceSessions({
		sessionsRoot: root,
		cwd: "/ws/proj",
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["gui-uuid-2", "lark-link:dm:oc_x:n1:0"],
	);
	assert.equal(rows[0]!.source, "scan");
	assert.ok(rows[0]!.createdAt >= rows[1]!.createdAt);
	rmSync(root, { recursive: true, force: true });
});

test("list: scan fallback with no sessions root returns []", async () => {
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent-root",
		cwd: "/ws/proj",
	});
	assert.deepEqual(rows, []);
});

test("list: service failure falls back to the filesystem scan", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-ws-list2-"));
	const dir = join(root, projectKeyOf("/ws/proj"));
	mkdirSync(join(dir, "only-one"), { recursive: true });
	writeFileSync(join(dir, "only-one", "session.jsonl.zstd"), "x");
	const persistence = {
		async list() {
			throw new Error("persistence down");
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: root,
		cwd: "/ws/proj",
		persistence,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, "only-one");
	assert.equal(rows[0]!.source, "scan");
	rmSync(root, { recursive: true, force: true });
});

test("extractTitleFromEvents: session/title event takes precedence over user/message", () => {
	const events = [
		{
			seq: 0,
			type: "user/message",
			data: {
				source: { kind: "user" },
				content: [{ type: "text", text: "First prompt text" }],
			},
		},
		{
			seq: 1,
			type: "session/title",
			data: { title: "Generated Session Title" },
		},
	];
	assert.equal(extractTitleFromEvents(events), "Generated Session Title");
});

test("extractTitleFromEvents: falls back to first human user message when no session/title", () => {
	const events = [
		{
			seq: 0,
			type: "user/message",
			data: {
				source: { kind: "user" },
				content: [{ type: "text", text: "帮我实现飞书机器人的流式卡片输出" }],
			},
		},
	];
	assert.equal(extractTitleFromEvents(events), "帮我实现飞书机器人的流式卡片输出");
});

test("list: inspect resolves titles from persistence events", async () => {
	const persistence = {
		async list() {
			return [{ id: "sess-1", createdAt: 1000, cwd: "/ws/proj" }];
		},
		async inspect(id: string) {
			if (id === "sess-1") {
				return {
					events: [
						{
							type: "user/message",
							data: {
								source: { kind: "user" },
								content: [{ type: "text", text: "测试会话标题提取" }],
							},
						},
					],
				};
			}
			return undefined;
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.title, "测试会话标题提取");
});


// ---- DSH 0.2.1 shapes: `{ header }` rows + generation filenames --------------

test("normalizeSessionHeader: accepts 0.2.1 { header } rows and legacy flat headers", () => {
	// 0.2.1 sessionQuery / sessionPersistence rows.
	const record = normalizeSessionHeader({
		header: {
			version: 4,
			id: "session-abc",
			createdAt: 1234,
			cwd: "/ws/proj",
			agentPreset: "ptc",
			origin: "subagent",
			title: "  Hello  ",
		},
		live: true,
		persisted: true,
	});
	assert.deepEqual(record, {
		id: "session-abc",
		createdAt: 1234,
		cwd: "/ws/proj",
		origin: "subagent",
		agentPreset: "ptc",
		title: "Hello",
	});
	// 0.1.x flat header.
	assert.deepEqual(normalizeSessionHeader({ id: "flat", createdAt: 7, cwd: "/a" }), {
		id: "flat",
		createdAt: 7,
		cwd: "/a",
	});
	// Unusable rows are dropped instead of becoming `undefined` sessions.
	assert.equal(normalizeSessionHeader({ createdAt: 1 }), undefined);
	assert.equal(normalizeSessionHeader({ header: { id: "   " } }), undefined);
	assert.equal(normalizeSessionHeader(null), undefined);
	// `updatedAt` is the documented fallback when a host omits createdAt.
	assert.deepEqual(normalizeSessionHeader({ header: { id: "x", updatedAt: 99 } }), {
		id: "x",
		createdAt: 99,
	});
});

test("list: 0.2.1 sessionQuery `{ header }` rows filter by cwd, sort desc, cap", async () => {
	const query = {
		async listSessions() {
			return [
				{
					header: {
						version: 4,
						id: "q-newer",
						createdAt: 3000,
						cwd: "/ws/proj",
						agentPreset: "ptc",
					},
					live: false,
					persisted: true,
				},
				{ header: { id: "q-older", createdAt: 1000, cwd: "/ws/proj" }, live: true },
				{ header: { id: "q-other-ws", createdAt: 5000, cwd: "/elsewhere" } },
				{ header: { id: "q-sub", createdAt: 4000, cwd: "/ws/proj", origin: "subagent" } },
				{ header: { id: "q-current", createdAt: 2000, cwd: "/ws/proj" } },
			];
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query,
		exclude: ["q-current"],
	});
	assert.deepEqual(rows.map((r) => r.id), ["q-newer", "q-older"]);
	assert.equal(rows[0]!.source, "query");
	assert.equal(rows[0]!.preset, "ptc");
	assert.equal(rows[0]!.createdAt, 3000);

	const capped = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query,
		limit: 1,
	});
	assert.deepEqual(capped.map((r) => r.id), ["q-newer"]);
});

test("list: sessionQuery wins over sessionPersistence; empty/throwing query falls back", async () => {
	const persistence = {
		async list() {
			return [{ id: "legacy", createdAt: 1, cwd: "/ws/proj" }];
		},
	};
	const query = {
		async listSessions() {
			return [{ header: { id: "from-query", createdAt: 2, cwd: "/ws/proj" } }];
		},
	};
	const preferred = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query,
		persistence,
	});
	assert.deepEqual(preferred.map((r) => r.id), ["from-query"]);
	assert.equal(preferred[0]!.source, "query");

	const emptyQuery = {
		async listSessions() {
			return [];
		},
	};
	const fallback = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query: emptyQuery,
		persistence,
	});
	assert.deepEqual(fallback.map((r) => r.id), ["legacy"]);
	assert.equal(fallback[0]!.source, "service");

	const failingQuery = {
		async listSessions(): Promise<never> {
			throw new Error("query down");
		},
	};
	const failed = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query: failingQuery,
		persistence,
	});
	assert.deepEqual(failed.map((r) => r.id), ["legacy"]);
});

test("list: 0.2.1 sessionPersistence.list() `{ header }` rows are normalized", async () => {
	const persistence = {
		async list() {
			return [
				{
					header: { version: 4, id: "v4-new", createdAt: 200, cwd: "/ws/proj" },
					formatStatus: "current",
					revision: "rev",
					sizeBytes: 10,
				},
				{
					header: { id: "v4-old", createdAt: 100, cwd: "/ws/proj", agentPreset: "standard" },
					formatStatus: "current",
					revision: "rev",
					sizeBytes: 10,
				},
				{ header: { id: "v4-other", createdAt: 300, cwd: "/other" } },
			];
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
	});
	assert.deepEqual(rows.map((r) => r.id), ["v4-new", "v4-old"]);
	assert.equal(rows[0]!.source, "service");
	assert.equal(rows[1]!.preset, "standard");
});

test("list: sessionQuery titles come from readTitle / readSession / listEvents", async () => {
	const query = {
		async listSessions() {
			return [
				{ header: { id: "t-readtitle", createdAt: 3, cwd: "/ws/proj" } },
				{ header: { id: "t-session", createdAt: 2, cwd: "/ws/proj" } },
				{ header: { id: "t-events", createdAt: 1, cwd: "/ws/proj" } },
				{ header: { id: "t-wrapped", createdAt: 0, cwd: "/ws/proj" } },
			];
		},
		async readTitle(id: string): Promise<unknown> {
			if (id === "t-readtitle") return "Title From Query";
			// No `session/title` event in the log → falls through to readSession.
			if (id === "t-session") return undefined;
			// Some hosts wrap the title in an object; `t-events` also has no
			// readSession, so only listEvents can supply its title.
			if (id === "t-wrapped") return { title: "Wrapped Title" };
			return undefined;
		},
		async readSession(id: string) {
			if (id === "t-session") {
				return {
					events: [
						{
							type: "user/message",
							data: {
								source: { kind: "user" },
								content: [{ type: "text", text: "首个用户消息作为标题" }],
							},
						},
					],
				};
			}
			return undefined;
		},
		async listEvents(_id: string) {
			return { events: [{ type: "session/title", data: { title: "Title From listEvents" } }] };
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		query,
	});
	const byId = new Map(rows.map((r) => [r.id, r.title]));
	assert.equal(byId.get("t-readtitle"), "Title From Query");
	assert.equal(byId.get("t-session"), "首个用户消息作为标题");
	assert.equal(byId.get("t-events"), "Title From listEvents");
	assert.equal(byId.get("t-wrapped"), "Wrapped Title");
});

test("parseGenerationLogFilename: canonical generation names only", () => {
	assert.equal(parseGenerationLogFilename("session.jsonl"), 0);
	assert.equal(parseGenerationLogFilename("session.jsonl.zstd"), 0);
	assert.equal(parseGenerationLogFilename("session.v1.jsonl.zstd"), 1);
	assert.equal(parseGenerationLogFilename("session.v3.jsonl.zstd"), 3);
	assert.equal(parseGenerationLogFilename("session.v4.jsonl.zstd"), 4);
	assert.equal(parseGenerationLogFilename("session.v12.jsonl"), 12);
	// Not canonical: explicit v0 tag, leading zero, temp/uppercase names.
	assert.equal(parseGenerationLogFilename("session.v0.jsonl.zstd"), undefined);
	assert.equal(parseGenerationLogFilename("session.v04.jsonl.zstd"), undefined);
	assert.equal(parseGenerationLogFilename("session.v4.jsonl.zstd.tmp"), undefined);
	assert.equal(parseGenerationLogFilename("Session.v4.jsonl.zstd"), undefined);
	assert.equal(parseGenerationLogFilename("session.lock"), undefined);
});

test("findSessionLogFile: picks the highest generation in a session dir", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-gen-log-"));
	try {
		const sessionDir = join(root, "lark-link~003Adm~003Aoc_x~003An1~003A0");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.lock"), "");
		assert.equal(findSessionLogFile(sessionDir), undefined, "lock file is not a log");
		writeFileSync(join(sessionDir, "session.jsonl.zstd"), "v0");
		assert.equal(basename(findSessionLogFile(sessionDir)!), "session.jsonl.zstd");
		writeFileSync(join(sessionDir, "session.v3.jsonl.zstd"), "v3");
		assert.equal(basename(findSessionLogFile(sessionDir)!), "session.v3.jsonl.zstd");
		writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), "v4");
		assert.equal(basename(findSessionLogFile(sessionDir)!), "session.v4.jsonl.zstd");
		// A plaintext artifact of the same generation is preferred only when
		// no compressed one exists at that generation.
		writeFileSync(join(sessionDir, "session.v5.jsonl"), "v5-plain");
		assert.equal(basename(findSessionLogFile(sessionDir)!), "session.v5.jsonl");
		assert.equal(findSessionLogFile(join(root, "missing")), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list: scan fallback recognizes 0.2.1 generation filenames", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-ws-gen-"));
	try {
		const dir = join(root, projectKeyOf("/ws/proj"));
		mkdirSync(join(dir, "lark-link~003Adm~003Aoc_x~003An2~003A0"), { recursive: true });
		writeFileSync(join(dir, "lark-link~003Adm~003Aoc_x~003An2~003A0", "session.lock"), "");
		writeFileSync(
			join(dir, "lark-link~003Adm~003Aoc_x~003An2~003A0", "session.v4.jsonl.zstd"),
			zstdCompressSync(Buffer.from('{"type":"session"}\n')),
		);
		mkdirSync(join(dir, "gui-uuid-9"), { recursive: true });
		writeFileSync(join(dir, "gui-uuid-9", "session.jsonl.zstd"), "v0");
		// A third directory with only a lock is not resumable.
		mkdirSync(join(dir, "no-log"), { recursive: true });
		writeFileSync(join(dir, "no-log", "session.lock"), "");

		const rows = await listWorkspaceSessions({ sessionsRoot: root, cwd: "/ws/proj" });
		assert.deepEqual(
			rows.map((r) => r.id).sort(),
			["gui-uuid-9", "lark-link:dm:oc_x:n2:0"].sort(),
		);
		assert.equal(rows.every((r) => r.source === "scan"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list: no sources at all returns []", async () => {
	assert.deepEqual(
		await listWorkspaceSessions({ sessionsRoot: "/nonexistent", cwd: "/ws/proj" }),
		[],
	);
	const emptyList = { async list() { return []; } };
	assert.deepEqual(
		await listWorkspaceSessions({
			sessionsRoot: "/nonexistent",
			cwd: "/ws/proj",
			persistence: emptyList,
		}),
		[],
	);
});

test("encodeSessionDirName: host encodeSegment parity", () => {
	assert.equal(
		encodeSessionDirName("lark-link:dm:oc_x:n1:0"),
		"lark-link~003Adm~003Aoc_x~003An1~003A0",
	);
	assert.equal(encodeSessionDirName("session-1234-abcd"), "session-1234-abcd");
	assert.equal(encodeSessionDirName("~"), "~007E");
	assert.equal(encodeSessionDirName("a b"), "a~0020b");
	assert.equal(encodeSessionDirName("."), "~002E");
	assert.equal(encodeSessionDirName(".."), "~002E~002E");
});

test("readSessionLogJsonl: decodes EVERY zstd frame (doctor export fallback)", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-log-jsonl-"));
	try {
		const compressed = join(root, "session.v4.jsonl.zstd");
		// DSH appends one FRAME per commit; whole-file zstd decompression would
		// stop after the first one, so the reader must walk every frame.
		const frame1 = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'));
		const frame2 = zstdCompressSync(Buffer.from('{"type":"user/message"}\n'));
		writeFileSync(compressed, Buffer.concat([frame1, frame2]));
		assert.equal(
			await readSessionLogJsonl(compressed),
			'{"type":"session","id":"s1"}\n{"type":"user/message"}\n',
		);

		const plain = join(root, "session.v5.jsonl");
		writeFileSync(plain, '{"type":"session"}\n');
		assert.equal(await readSessionLogJsonl(plain), '{"type":"session"}\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


// ---- saved workspaces (/ws store) ------------------------------------------

function tempWorkspaceFile(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "lark-link-ws-"));
	return { dir, file: join(dir, "state", "workspaces.json") };
}

test("saved workspaces: default file lives under <DSH_HOME>/lark-link", () => {
	assert.equal(
		defaultWorkspacesFile({ DSH_HOME: "/tmp/dsh-home" } as NodeJS.ProcessEnv),
		join("/tmp/dsh-home", "lark-link", "workspaces.json"),
	);
	// Unset DSH_HOME → ~/.dsh/lark-link/workspaces.json
	assert.match(defaultWorkspacesFile({} as NodeJS.ProcessEnv), /[/\\]\.dsh[/\\]lark-link[/\\]workspaces\.json$/);
});

test("saved workspaces: normalize drops trailing separators, keeps roots", () => {
	assert.equal(normalizeWorkspacePath("  /Users/me/app/  "), "/Users/me/app");
	assert.equal(normalizeWorkspacePath("/"), "/");
	assert.equal(normalizeWorkspacePath(""), "");
	assert.equal(normalizeWorkspacePath("D:\\work\\app\\"), "D:\\work\\app");
	assert.equal(normalizeWorkspacePath("D:\\"), "D:\\");
});

test("saved workspaces: comparison folds separators and Windows case", () => {
	assert.equal(sameWorkspacePath("/a/b", "/a/b/"), true);
	assert.equal(sameWorkspacePath("/a/b", "/a/c"), false);
	assert.equal(sameWorkspacePath("D:\\Work\\App", "d:\\work\\app"), true);
	assert.equal(sameWorkspacePath("", ""), false);
});

test("saved workspaces: add/list/remove round-trips through JSON", () => {
	const { dir, file } = tempWorkspaceFile();
	try {
		let now = 1000;
		const store = createSavedWorkspaceStore(file, () => (now += 1));
		assert.deepEqual(store.list(), []);
		assert.equal(store.file(), file);

		const first = store.add("/Users/me/app");
		assert.equal(first.added, true);
		assert.equal(first.index, 0);
		assert.equal(first.entry.path, "/Users/me/app");
		assert.equal(first.entry.addedAt, 1001);

		const second = store.add(dir, "project");
		assert.equal(second.added, true);
		assert.equal(second.entry.label, "project");
		assert.equal(second.index, 1);

		// Duplicate add (trailing separator) does not append.
		const dup = store.add("/Users/me/app/");
		assert.equal(dup.added, false);
		assert.equal(dup.index, 0);
		assert.equal(store.list().length, 2);

		// A fresh store reads the persisted file.
		const reloaded = createSavedWorkspaceStore(file);
		assert.deepEqual(
			reloaded.list().map((entry) => entry.path),
			["/Users/me/app", dir],
		);
		assert.equal(reloaded.has("/Users/me/app"), true);
		assert.equal(reloaded.has("/nope"), false);

		assert.equal(reloaded.remove("/Users/me/app/"), true);
		assert.equal(reloaded.remove("/Users/me/app"), false);
		assert.deepEqual(
			createSavedWorkspaceStore(file).list().map((entry) => entry.path),
			[dir],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saved workspaces: touch records lastUsedAt without reordering", () => {
	const { dir, file } = tempWorkspaceFile();
	try {
		const store = createSavedWorkspaceStore(file, () => 5000);
		store.add("/a");
		store.add("/b");
		store.touch("/b");
		const rows = store.list();
		assert.deepEqual(rows.map((row) => row.path), ["/a", "/b"], "order is add order");
		assert.equal(rows[1]!.lastUsedAt, 5000);
		assert.equal(rows[0]!.lastUsedAt, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saved workspaces: findSavedWorkspace resolves 1-based numbers and paths", () => {
	const entries = [
		{ path: "/a", addedAt: 1 },
		{ path: "/b", addedAt: 2 },
	];
	assert.deepEqual(findSavedWorkspace(entries, "2")?.entry.path, "/b");
	assert.equal(findSavedWorkspace(entries, "3"), undefined);
	assert.equal(findSavedWorkspace(entries, "0"), undefined);
	assert.deepEqual(findSavedWorkspace(entries, "/a/")?.index, 0);
	assert.equal(findSavedWorkspace(entries, "/c"), undefined);
	assert.equal(findSavedWorkspace(entries, ""), undefined);
});

test("saved workspaces: corrupt or legacy files never throw", () => {
	const { dir, file } = tempWorkspaceFile();
	try {
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(file, "{ not json");
		assert.deepEqual(createSavedWorkspaceStore(file).list(), []);

		// Legacy bare-array format is still readable.
		writeFileSync(
			file,
			JSON.stringify([{ path: "/legacy", addedAt: 7 }, { nope: true }, { path: "  " }]),
		);
		const rows = createSavedWorkspaceStore(file).list();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.path, "/legacy");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
