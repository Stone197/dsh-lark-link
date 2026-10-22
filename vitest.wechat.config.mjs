// Vitest config for the ported WeChat channel (tests-wechat/**).
//
// The Feishu half of dsh-lark-link is covered by `node:test` (`test/**`,
// `npm test`); the WeChat channel arrived from pan17/dsh-wechat with a Vitest
// suite, so it keeps its own runner and config. `npm run test:wechat` runs
// this file.
//
// The suite lives under `tests-wechat/` with import paths rewritten to
// `../src/wechat/**`; the channel-internal module layout is unchanged.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests-wechat/**/*.test.ts"],
		environment: "node",
		// Reclaims the temp dirs the suite creates with `mkdtempSync`, which
		// creates but never deletes. Without this each run orphans hundreds of
		// dirs (ported from dsh-wechat's own config).
		globalSetup: ["./tests-wechat/temp-cleanup.setup.ts"],
		// Vitest v4 can tear the worker RPC down while a console.log is still
		// in flight (EnvironmentTeardownError: Closing rpc while
		// "onUserConsoleLog" was pending). All tests already passed; the leftover
		// rejection fails the run anyway. See vitest-dev/vitest#9458.
		onUnhandledError(error) {
			const message = String(error?.message ?? error);
			if (
				error?.name === "EnvironmentTeardownError" &&
				message.includes('Closing rpc while "onUserConsoleLog" was pending')
			) {
				return false;
			}
		},
	},
});
