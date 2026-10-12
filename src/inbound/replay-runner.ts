// ReplayRunner (GH #14): the inbound-request replay routine, extracted from
// the bridge entry so the SAME code path serves both the boot-time automatic
// replay and the manual `/lark replay` trigger. Given a WAL of accepted but
// never-delivered requests, each pending record is first offered to the
// salvage path (answer from the persisted session log) and only re-dispatched
// through the live pipeline when no usable output exists.
//
// Harness-agnostic: dispatch is injected. `trigger` is informational only —
// auto-replay gating (replay.auto / DSH_LARK_AUTO_REPLAY) lives at the call
// sites, never here, so a manual trigger is never blocked by the switch.

import type { InboundWal, InboundWalRecord } from "./inbound-wal.ts";

export interface ReplayRunnerDeps {
  wal: InboundWal;
  /** Answer from the persisted session log; true = handled, no re-run. */
  salvage(rec: InboundWalRecord, sessionId: string | undefined): Promise<boolean>;
  /** Active DSH session id for a conversation key (salvage target). */
  activeSessionId(sessionKey: string): string | undefined;
  /** Re-dispatch the request through the normal inbound pipeline (skipDedupe). */
  redispatch(rec: InboundWalRecord): Promise<void>;
  /** Housekeeping before the sweep (prune expired / terminal-mark limbo). */
  prune?(): void;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export interface ReplayRunResult {
  /** Records answered from session logs (no agent re-run). */
  salvaged: number;
  /** Records re-dispatched through the live pipeline. */
  replayed: number;
  /** Records that could not be replayed (cap/window exhausted → failed). */
  skipped: number;
  /** Post-run pending / failed counts (for /status refresh). */
  pending: number;
  failed: number;
}

export function createReplayRunner(deps: ReplayRunnerDeps) {
  return {
    async run(): Promise<ReplayRunResult> {
      let salvaged = 0;
      let replayed = 0;
      let skipped = 0;
      deps.prune?.();
      for (const rec of deps.wal.pendingReplays()) {
        if (!deps.wal.markReplay(rec.messageId)) {
          skipped++;
          continue;
        }
        // GH #9: the previous run may have COMPLETED the agent turn — the
        // session log already holds the final assistant output and only the
        // bridge event was lost. Answer from the log first; re-run the agent
        // only when no usable output exists.
        if (await deps.salvage(rec, deps.activeSessionId(rec.sessionKey))) {
          salvaged++;
          continue;
        }
        try {
          await deps.redispatch(rec);
          replayed++;
        } catch (err) {
          skipped++;
          deps.logger?.warn(
            `inbound replay failed for ${rec.messageId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (salvaged > 0 || replayed > 0)
        deps.logger?.info(
          `inbound replay: ${salvaged} answered from session logs, ${replayed} re-dispatched`,
        );
      return {
        salvaged,
        replayed,
        skipped,
        pending: deps.wal.pendingReplays().length,
        failed: deps.wal.failedCount(),
      };
    },
  };
}
