// EventForwarder: the bridge's outbound "assistant → Feishu" pipeline.
// Consumes DSH session events (assistant/chunk for streaming, assistant/message
// for the durable final, turn/end for completion) and pushes them either into
// the volatile LiveChannel (streaming card) or the persistent Outbox (final +
// DONE reaction).
//
// Interaction-parity mode (`cfg.runCardEnabled`, docs/UNIFIED-IM-BRIDGE.md):
// one turn = ONE live run card. turn/start creates it, every event folds into
// the run view and is pushed as a throttled whole-card update, turn/end
// finalizes it (streaming off + durable PUT). The card is the turn's durable
// delivery: when finalize succeeds no plain-text message is enqueued (no
// duplicates). When it fails the collected text falls back to the outbox, so
// content is never lost. DONE reaction / onDelivered semantics are unchanged.
//
// Harness-agnostic: receives normalized DSH events through an injected
// subscribe function so this module stays unit-testable without DSH.

import type {
  GoalSnapshotState,
  Route,
  RouteRef,
  RunBridgeEvent,
  TodoItemState,
} from "../common/types.ts";
import type { Outbox } from "./outbox.ts";
import type { CardKitStreamHandle } from "./cardkit-stream.ts";
import type { TaskCardSyncer } from "./task-card-syncer.ts";
import {
  createRunView,
  finalizeRunView,
  reduceRunView,
  runViewHasContent,
  runViewText,
  type RunViewState,
} from "../presentation/run-state.ts";
import { renderRunCard } from "../presentation/run-renderer.ts";

/** A normalized slice of the DSH session event surface we care about. */
export type BridgeSessionEvent = RunBridgeEvent;

export interface StreamTarget {
  route: RouteRef;
  /** Create (or reuse) a streaming card handle for this turn. */
  ensureStream(): CardKitStreamHandle | undefined;
  /**
   * Create (or reuse) the WHOLE-CARD run handle for this turn (interaction
   * parity). Optional: deployments without CardKit keep the legacy paths.
   */
  ensureRunStream?(): CardKitStreamHandle | undefined;
  /** Send a plain-text reply through the outbox (no card). */
  fallbackText(text: string): Promise<void>;
  /** Mark the turn complete (DONE reaction on the trigger message). */
  markDone(): Promise<void>;
}

export interface ForwarderConfig {
  streamingEnabled: boolean;
  /** Whole-card run view (one card per turn). Defaults to off. */
  runCardEnabled?: boolean;
}

export interface EventForwarderDeps {
  outbox: Outbox;
  /** Live task and goal board card syncer (optional). */
  taskCardSyncer?: TaskCardSyncer;
  /** Map a session event to the Feishu route it belongs to. */
  routeFor(sessionKey: string): Route | undefined;
  /** Live streaming target per session (volatile). */
  streamFor(sessionKey: string): StreamTarget | undefined;
  /** Config getter — read per event (hot-reload friendly). */
  cfg: () => ForwarderConfig;
  /**
   * Sign the run card's ⏹ stop callback (anti-forgery). Returns the token to
   * embed in the button value; when absent the button uses the legacy bare
   * `op:"stop"` value.
   */
  stopCallbackToken?(route: RouteRef, action: string): string | undefined;
  /**
   * Called when a session's durable (per-turn) output is enqueued into the
   * outbox. Lets the inbound WAL mark the triggering user request delivered —
   * the durable output IS the proof the turn completed, so that request won't
   * be re-triggered after a crash. Best-effort; failures are swallowed.
   */
  onDelivered?(sessionKey: string): void;
}

export interface EventForwarder {
  /** Feed one normalized DSH session event for a session key. */
  onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void>;
  /** Finalize any in-flight streaming cards for a session. */
  finalizeSession(sessionKey: string): Promise<void>;
}

interface SessionState {
  stream?: CardKitStreamHandle;
  acc: string;
  lastFlushAt: number;
  /** True once any non-empty assistant text has been delivered this turn. */
  hasOutput: boolean;
  /** True once the turn/end rescue has been issued (avoid duplicates). */
  rescueIssued: boolean;
  /** True once markDone has been issued (avoid duplicates). */
  doneIssued: boolean;
  /** Whole-card run view / handle for the CURRENT turn (interaction parity). */
  runView?: RunViewState;
  runHandle?: CardKitStreamHandle;
}

export function createEventForwarder(deps: EventForwarderDeps): EventForwarder {
  const state = new Map<string, SessionState>();

  const emptyState = (): SessionState => ({
    acc: "",
    lastFlushAt: Date.now(),
    hasOutput: false,
    rescueIssued: false,
    doneIssued: false,
  });

  const routeRefFor = (route: Route): RouteRef => ({
    sessionKey: route.sessionKey,
    chatId: route.chatId,
    chatType: route.chatType,
    threadMessageId: route.threadMessageId,
  });

  /** Render options for the run card (signed stop token when configured). */
  const renderOptions = (route: Route): { stopToken?: string } => {
    let token: string | undefined;
    try {
      token = deps.stopCallbackToken?.(routeRefFor(route), "stop");
    } catch {
      token = undefined;
    }
    return token ? { stopToken: token } : {};
  };

  const runCardActive = (st: SessionState): boolean =>
    st.runView !== undefined && st.runHandle !== undefined && !st.runHandle.disposed;

  /** Render + push the current run view as a throttled whole-card update. */
  async function pushRunCard(st: SessionState, route: Route): Promise<void> {
    if (!st.runView || !st.runHandle) return;
    if (st.runHandle.disposed) {
      st.runHandle = undefined;
      st.runView = undefined;
      return;
    }
    try {
      await st.runHandle.updateCard(renderRunCard(st.runView, renderOptions(route)));
    } catch {
      // updateCard is non-fatal by contract; a disposed handle is handled below.
    }
    if (st.runHandle?.disposed) {
      st.runHandle = undefined;
      st.runView = undefined;
    }
  }

  /** Open the run card for a new turn (best-effort; failure = legacy mode). */
  async function startRunCard(st: SessionState, sessionKey: string, route: Route): Promise<void> {
    st.runView = undefined;
    st.runHandle = undefined;
    if (!deps.cfg().runCardEnabled) return;
    const handle = deps.streamFor(sessionKey)?.ensureRunStream?.();
    if (!handle) return;
    st.runView = createRunView();
    st.runHandle = handle;
    await pushRunCard(st, route);
  }

  async function onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void> {
    const route = deps.routeFor(sessionKey);
    if (!route) return; // no Feishu route for this session — nothing to forward

    const st = state.get(sessionKey) ?? emptyState();
    state.set(sessionKey, st);

    switch (event.type) {
      case "turn/start":
        // New turn: reset per-turn delivery state. doneIssued/hasOutput/acc
        // must not leak across turns — otherwise only the FIRST turn of a
        // session ever gets its DONE reaction (pi lesson: 每轮都要打 DONE).
        st.hasOutput = false;
        st.rescueIssued = false;
        st.doneIssued = false;
        st.acc = "";
        st.stream = undefined;
        await startRunCard(st, sessionKey, route);
        break;

      case "reasoning/delta": {
        if (!runCardActive(st)) return;
        st.runView = reduceRunView(st.runView!, {
          type: "reasoning-delta",
          text: event.text,
        });
        await pushRunCard(st, route);
        break;
      }

      case "assistant/chunk": {
        // Streaming is volatile preview only (ADR-8); the durable per-turn
        // delivery happens on assistant/message (legacy) or turn/end (run
        // card). When streaming is off (default, 省流量 — pi 31dc3c9), chunks
        // are ignored entirely.
        const { streamingEnabled } = deps.cfg();
        if (runCardActive(st)) {
          st.acc += event.text;
          st.runView = reduceRunView(st.runView!, {
            type: "text-delta",
            text: event.text,
          });
          await pushRunCard(st, route);
          return;
        }
        if (!streamingEnabled) return;
        st.acc += event.text;
        if (!st.stream || st.stream.disposed) {
          const stream = deps.streamFor(sessionKey)?.ensureStream();
          if (stream && !stream.disposed) st.stream = stream;
        }
        if (st.stream && !st.stream.disposed) {
          await st.stream.patch(event.text);
        }
        break;
      }

      case "assistant/message": {
        // Each complete assistant output is delivered as ONE Feishu message
        // (pi bdbc0a2: 每轮输出逐条发, turn_end 不再重复发最终). Empty output
        // (e.g. goal-activation turns) is skipped entirely (pi 5ac1c3d).
        const text = st.acc.length > event.text.length ? st.acc : event.text;
        st.acc = "";
        const hasText = text.trim() !== "" && text !== "No response.";
        if (hasText) st.hasOutput = true;

        // Run card mode: the card accumulates blocks and is delivered at
        // turn/end, so do not enqueue a duplicate plain-text message.
        if (runCardActive(st)) {
          st.runView = reduceRunView(st.runView!, {
            type: "message",
            text,
            reasoning: event.reasoning,
          });
          await pushRunCard(st, route);
          if (runCardActive(st)) break; // card owns the delivery
          // Card died mid-turn → fall through to the durable paths below.
        }

        if (!hasText) return;
        if (st.stream && !st.stream.disposed) {
          // Streaming card active: settle it. On ANY failure fall through to
          // the durable outbox so content is never lost.
          try {
            const finalId = await st.stream.finalize(text);
            if (!finalId) throw new Error("CardKit finalize returned empty cardId");
            st.stream = undefined;
            deps.onDelivered?.(sessionKey); // card is final — treat as delivered
            return;
          } catch {
            st.stream = undefined;
            // fall through → outbox
          }
        }
        await deps.outbox.enqueue({
          // GH #15: key idempotency on DSH's stable AssistantMessage.id when
          // available. The previous `text.length:Date.now()` key was UNIQUE
          // on every enqueue, so a duplicated event delivery (leaked
          // session/event subscription) produced two identical Feishu
          // messages — and two different replies of equal length within the
          // same millisecond could be wrongly collapsed instead. The
          // Date.now() fallback only applies when messageId is absent
          // (legacy mocks), preserving prior behavior there.
          dedupeKey: event.messageId
            ? `${sessionKey}:assistant:msg:${event.messageId}`
            : `${sessionKey}:assistant:${text.length}:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text },
        });
        deps.onDelivered?.(sessionKey); // durable enqueue — request is delivered
        break;
      }

      case "tool/call":
      case "tool/result": {
        // Tool activity is only rendered on the live run card; no per-tool
        // Feishu messages (legacy behavior preserved when no card is active).
        if (!runCardActive(st)) return;
        if (event.type === "tool/call") {
          st.runView = reduceRunView(st.runView!, {
            type: "tool-call",
            callId: event.callId,
            name: event.name,
            arguments: event.arguments,
          });
        } else {
          st.runView = reduceRunView(st.runView!, {
            type: "tool-result",
            callId: event.callId,
            name: event.name,
            output: event.output,
            isError: event.isError,
            error: event.error,
          });
        }
        await pushRunCard(st, route);
        break;
      }

      case "turn/end": {
        // Turn completion: the last assistant/message was already delivered
        // (no duplicate final — pi bdbc0a2). Finalize any leftover streaming
        // card; issue the DONE reaction ONLY when real output was delivered
        // (pi 5ac1c3d: 空输出不打 DONE).
        st.acc = "";
        if (st.stream) {
          try {
            await st.stream.finalize("");
          } catch {
            // ignore
          }
          st.stream = undefined;
        }

        // Settle the run card (if any): its finalize is the durable delivery.
        let runCardFailed = false;
        let runText = "";
        if (st.runView) {
          const handle = st.runHandle;
          runText = runViewText(st.runView);
          const finalView = reduceRunView(st.runView, {
            type: "turn-end",
            reason: event.reason,
            errorMessage: event.errorMessage,
          });
          st.runView = undefined;
          st.runHandle = undefined;
          if (handle && !handle.disposed) {
            try {
              const finalId = await handle.finalizeCard(
                renderRunCard(finalView, renderOptions(route)),
              );
              if (!finalId) throw new Error("CardKit finalizeCard returned empty cardId");
              if (runViewHasContent(finalView)) st.hasOutput = true;
              deps.onDelivered?.(sessionKey); // card is final — treat as delivered
            } catch {
              runCardFailed = true;
            }
          } else {
            runCardFailed = true;
          }
        }

        // GH #9 兜底 (rescue): the turn produced assistant output but nothing
        // was durably delivered THIS turn — the assistant/message event was
        // lost (plugin reload mid-turn, subscription re-race), outbox.enqueue
        // threw, or the route only appeared after the message. The adapter
        // attaches the session's final assistant text to turn/end; enqueue it
        // now so the user still gets the reply instead of silence. This is
        // also a SECOND, independent path to onDelivered (the inbound WAL no
        // longer depends solely on the assistant/message callback).
        const rescue = (event.finalText ?? "").trim() !== "" ? event.finalText : "";
        if (runCardFailed && runText.trim() !== "") {
          // The run card could not be finalized: deliver what the card showed.
          try {
            await deps.outbox.enqueue({
              dedupeKey: `${sessionKey}:runcard-fallback:${runText.length}:${Date.now()}`,
              laneKey: sessionKey,
              route: routeRefFor(route),
              kind: "assistant-output",
              payload: { kind: "text", text: runText },
            });
            st.hasOutput = true;
          } catch {
            // Best effort — the inbound WAL still holds the undelivered record.
          }
        }
        if (!st.hasOutput && !st.rescueIssued && rescue && rescue !== "No response.") {
          // GH #15: claim the rescue BEFORE awaiting the enqueue — a
          // duplicated turn/end delivery must never run two concurrent
          // rescues (both would pass the hasOutput check and enqueue twice).
          st.rescueIssued = true;
          try {
            await deps.outbox.enqueue({
              dedupeKey: `${sessionKey}:rescue:${rescue.length}:${Date.now()}`,
              laneKey: sessionKey,
              route: routeRefFor(route),
              kind: "assistant-output",
              payload: { kind: "text", text: rescue },
            });
            st.hasOutput = true;
            deps.onDelivered?.(sessionKey);
          } catch {
            // Rescue is best-effort: the record stays undelivered in the
            // inbound WAL, so boot replay still applies. Never break the
            // rest of turn/end handling (markDone) on a rescue failure.
          }
        }
        const target = deps.streamFor(sessionKey);
        if (target && st.hasOutput && !st.doneIssued) {
          st.doneIssued = true;
          await target.markDone();
        }
        break;
      }

      case "todo/write":
      case "goal/change":
        // Internal DSH state updates (not sent as Feishu task cards here).
        break;
    }
  }

  async function finalizeSession(sessionKey: string): Promise<void> {
    const st = state.get(sessionKey);
    if (!st) return;
    const route = deps.routeFor(sessionKey);
    // A run card still live at shutdown/reload must land its final state
    // durably; if that fails fall back to the outbox text below.
    if (st.runView && st.runHandle) {
      const finalView = finalizeRunView(st.runView);
      const runText = runViewText(finalView);
      try {
        const finalId = await st.runHandle.finalizeCard(
          renderRunCard(finalView, route ? renderOptions(route) : {}),
        );
        if (!finalId) throw new Error("CardKit finalizeCard returned empty cardId");
        if (runViewHasContent(finalView)) st.hasOutput = true;
        deps.onDelivered?.(sessionKey);
        st.acc = "";
      } catch {
        if (runText.trim() !== "" && route) {
          await deps.outbox.enqueue({
            dedupeKey: `${sessionKey}:finalize-runcard:${Date.now()}`,
            laneKey: sessionKey,
            route: routeRefFor(route),
            kind: "assistant-output",
            payload: { kind: "text", text: runText },
          });
          st.hasOutput = true;
        }
      }
      st.runView = undefined;
      st.runHandle = undefined;
    }
    if (st.acc.length > 0 && st.hasOutput === false) {
      // Streaming-only accumulated text never settled by a message_end.
      if (route) {
        await deps.outbox.enqueue({
          dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text: st.acc },
        });
      }
    }
    if (st.stream) {
      try {
        await st.stream.finalize("");
      } catch {
        // ignore
      }
      st.stream = undefined;
    }
    state.delete(sessionKey);
  }

  return { onSessionEvent, finalizeSession };
}
