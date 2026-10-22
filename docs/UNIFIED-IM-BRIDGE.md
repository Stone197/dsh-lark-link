# Unified IM bridge — design & work split (internal)

Branch: `feat/unified-im-bridge` (from `main`, package name stays `dsh-lark-link`, version `0.7.0`).

Goal: **one plugin, one package, two IM channels** for DeepSeek Harness.

| Source | What we take |
|---|---|
| `amlyczz/dsh-lark-link` @0.6.0 | Feishu engine (transport / outbox / inbound WAL / cardkit / adapter / client console) as the base |
| `zarazhangrui/lark-coding-agent-bridge` | live run-card interaction model: one card per run, reasoning panel, tool-call panels, >3 collapse, footer status, stop button, streaming summary, debounce queue, `/cd` + `/ws` |
| `pan17/dsh-wechat` @0.13.3 | whole WeChat channel (iLink long-poll, QR login, media, merge, silent/final, approval & question mirroring, `/at`, settings page, help catalog) |

## Runtime layout

```
src/
  index.ts                 # ONE Cordis apply: Feishu engine + WeChat channel
  common/ host/ inbound/ outbound/ sessions/ presentation/ application/
                           # existing Feishu engine (paths unchanged)
  wechat/                  # ported dsh-wechat (channel-internal paths unchanged)
    index.ts               # re-exports applyWechatChannel
    plugin.ts              # applyWechatChannel(ctx, config) -> disposer  ← contract
    bridge/ dsh/ adapter/ weixin/ utils/ config*.ts qr.ts help-catalog.ts ...
  client/                  # ONE client bundle: Feishu console + WeChat section
```

Contract between the two halves:

```ts
// src/wechat/index.ts
export function applyWechatChannel(
  ctx: unknown,                      // same Cordis Context as the Feishu engine
  config: WechatChannelConfig,       // cordis.patch.yml `wechat:` block
): () => void | Promise<void>;       // disposer, parked on the plugin fiber
```

Rules:
- The WeChat half never imports from `../index.ts` and never touches Feishu modules.
- Both halves may use `ctx.get("...")` / `ctx.on("...")` / `ctx.effect(...)` / `ctx.tools.register(...)`.
- Storage: Feishu `~/.dsh/lark-link` (existing, keep). WeChat `~/.dsh-wechat` (existing, keep so a standalone dsh-wechat login is reused without re-scan). Plugin config can override `wechat.storageDir`.
- Client routes: keep the WeChat HTTP prefix `/wechat/api/*` and section id `wechat`; Feishu keeps its own.
- Config: `cordis.patch.yml` → one entry `lark-link` with flat Feishu keys + nested `wechat:` block.

## Feishu run-card (bridge interaction parity)

Reference implementation to port/adapt:
- `lark-coding-agent-bridge/src/card/run-state.ts` (state reducer)
- `.../run-renderer.ts` (schema 2.0 element tree)
- `.../tool-render.ts` (tool header + body, caps)
- `.../bot/channel.ts` (streaming controller: create card, throttled update, finalize)
- `.../bot/pending-queue.ts` (debounce per scope)

Target hook points in this repo:
- `src/sessions/dsh-adapter.ts` — normalize more events: `tool/call` (callId/name/arguments), `tool/result` (output/error), reasoning (`assistant/message` reasoning blocks + `agent/assistant-stream` reasoning-delta).
- `src/common/types.ts` (or a new run-view module) — extend `BridgeSessionEvent`.
- `src/outbound/event-forwarder.ts` — feed events into a per-turn run view; render and push the card.
- `src/outbound/cardkit-stream.ts` — add full-card update (`PUT /open-apis/cardkit/v1/cards/:id`) alongside the existing markdown element stream, with one shared monotonic `sequence`; keep the 800ms rate gate and finalize semantics (durable final must throw on failure so outbox fallback still works).
- `src/presentation/` — keep the existing command cards; add run-card renderer in a new file.
- Stop button: CardKit button `value: {cmd:"stop"}` — reuse the existing card-action callback path (see how `/mode` cards handle callbacks in `src/index.ts` / `src/inbound/transport.ts`).

Tool names in this repo are DSH ids (`bash`, `read`, `edit`, `grep`, `glob`, `web_search`, `todo_write`, `spawn_teammate` …), not Claude Code names. Use the display-title map in `dsh-wechat/src/adapter/process-format.ts` as the source of friendly names.

## Debounce queue + `/cd` `/ws`

- Debounce: adapt `lark-coding-agent-bridge/src/bot/pending-queue.ts` — per session key quiet window, blocked while a turn runs, flush as one prompt; commands bypass.
- Workspaces: `src/sessions/workspace-sessions.ts` already lists DSH sessions; add a saved-workspace store (`/ws list|add|use|remove`) and `/cd <path>` alias; persist under `~/.dsh/lark-link/workspaces.json`.
- WeChat already has `/ws` (list/switch/add); add `/cd` alias in `src/wechat/bridge/slash.ts`.

## Unified client & help

- `src/client/index.ts` is the only client entry (tsdown → `dist/client.js`).
- Register *both* sections from this one bundle:
  - `settings.section` id `lark-link` order 25 (existing console)
  - `settings.section` id `wechat` order 40 (port `dsh-wechat/src/client.js` WechatSection)
- Help: one catalog module (`src/help/catalog.ts`) exported to both channels' `/help`; Feishu `/help` card stays a card, WeChat `/help` stays two-level text.
- WeChat client fetches `/wechat/api/*`; Feishu client keeps its existing routes.

## Commands/tests

Toolchain (bundled with DSH desktop 0.2.1-rc.2):

```bash
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
node "$PNPM" install --ignore-scripts
node "$PNPM" run check
node "$PNPM" run test          # node:test, test/**/*.test.ts
node "$PNPM" run test:wechat   # vitest, tests-wechat/**/*.test.ts
node "$PNPM" run build
```

## Ownership (avoid overlapping writes)

- Lead: `package.json`, `cordis.patch.yml`, `src/index.ts`, docs/README/CHANGELOG, integration, build, push.
- feishu-runview: `src/outbound/**`, `src/sessions/dsh-adapter.ts`, `src/common/types.ts`, new `src/presentation/run-*`, `test/unit/outbound/**`, `test/unit/sessions/dsh-adapter.test.ts`.
- wechat-channel: `src/wechat/**`, `tests-wechat/**`, `vitest.wechat.config.mjs`.
- client-commands: `src/client/**`, `src/application/command-router.ts`, `src/presentation/cards.ts`, `src/sessions/workspace-sessions.ts`, `src/inbound/transport.ts` (card-action callback), `test/unit/application/**`, `test/unit/presentation/**`, `test/unit/sessions/workspace-sessions.test.ts`.
