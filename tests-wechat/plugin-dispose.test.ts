// Ported from pan17/dsh-wechat v0.13.3 (MIT) — WeChat channel of the
// unified dsh-lark-link plugin. Adapted to the `applyWechatChannel` contract.
/**
 * Host-contract hardening guards that only show up at the channel boundary.
 *
 * Adapted from dsh-wechat's `tests/plugin-dispose.test.ts`. The standalone
 * package's version also drove its own client bundle (`src/client.js`) to
 * prove the settings section's `slots.inject` disposer survived; in the
 * unified repo the WeChat settings section is part of the shared client
 * bundle (`src/client/**`, owned by the client/commands workstream), so this
 * file guards the HOST half only:
 *
 *   - `send_wechat` must be UNREGISTERED when the channel is disposed. The
 *     registration's disposer used to be discarded, so a reload left the tool
 *     bound to a dead bridge.
 *   - `applyWechatChannel` must return a callable disposer (the unified
 *     plugin parks it on its own fiber), and running it must not throw.
 *
 * Both halves are checked structurally — the real Cordis runtime is not
 * present in this repo, so the tests drive `applyWechatChannel()` with a
 * recording fake context.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyWechatChannel } from "../src/wechat/index.js";

/** Minimal context recording what the channel registered and how it disposes. */
function makeHostContext() {
	const disposed: string[] = [];
	const effects: Array<() => unknown> = [];
	const toolsRegister = vi.fn((definition: { name?: string }) => () => {
		disposed.push(definition.name ?? "?");
	});
	const ctx = {
		get: (name: string) => (name === "tools" ? { register: toolsRegister } : undefined),
		on: () => () => {},
		inject: (_deps: string[], callback: (ctx: unknown) => unknown) => callback(ctx),
		effect: (body: () => unknown) => {
			const disposer = body();
			if (typeof disposer === "function") effects.push(disposer as () => unknown);
			return () => {};
		},
	};
	return { ctx, disposed, effects, toolsRegister };
}

/** One applied channel plus the storage dir it must clean up. */
async function applyChannel() {
	const host = makeHostContext();
	const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-dispose-"));
	const stop = applyWechatChannel(host.ctx as never, { storageDir, silent: true } as never);
	return { host, stop, storageDir };
}

describe("A4: send_wechat registration is parked on a disposer", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		vi.restoreAllMocks();
	});

	it("captures the tools.register disposer through ctx.effect", async () => {
		const { host, stop, storageDir } = await applyChannel();
		try {
			expect(host.toolsRegister).toHaveBeenCalledTimes(1);
			expect(host.toolsRegister.mock.calls[0]![0]).toMatchObject({ name: "send_wechat" });
			// The effect body returned the unregister function; the host owns it now.
			expect(host.effects.length).toBeGreaterThan(0);
			expect(host.disposed).toEqual([]);
			await stop();
		} finally {
			fs.rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("running the parked disposer unregisters the tool", async () => {
		const { host, stop, storageDir } = await applyChannel();
		try {
			for (const dispose of host.effects) dispose();
			expect(host.disposed).toContain("send_wechat");
			await stop();
		} finally {
			fs.rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("returns a disposer that stops the bridge without throwing", async () => {
		const { stop, storageDir } = await applyChannel();
		try {
			expect(typeof stop).toBe("function");
			await expect(Promise.resolve(stop())).resolves.toBeUndefined();
		} finally {
			fs.rmSync(storageDir, { recursive: true, force: true });
		}
	});
});

describe("A4b: a disabled channel registers nothing", () => {
	it("wechat.enabled=false returns a no-op disposer and skips tools", async () => {
		const host = makeHostContext();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const stop = applyWechatChannel(host.ctx as never, { enabled: false } as never);
			expect(host.toolsRegister).not.toHaveBeenCalled();
			expect(host.effects).toEqual([]);
			await expect(Promise.resolve(stop())).resolves.toBeUndefined();
		} finally {
			logSpy.mockRestore();
			vi.restoreAllMocks();
		}
	});
});
