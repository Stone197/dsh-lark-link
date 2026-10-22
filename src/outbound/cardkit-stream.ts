// CardKit schema 2.0 streaming card client (ADR-8). Implements the OFFICIAL
// CardKit v1 flow (verified against open.feishu.cn docs, 2026-08):
//
//   1. POST /open-apis/cardkit/v1/cards
//      body {type:"card_json", data:"<stringified card JSON>"} (FLAT)
//      → {data:{card_id}} — creates a card ENTITY with streaming_mode on.
//   2. im/v1/messages (msg_type "interactive",
//      content {"type":"card","data":{"card_id"}}) — delivers the entity into
//      the chat. An entity can be sent EXACTLY ONCE, so this happens right
//      after creation.
//   3. PUT /cards/:card_id/elements/:element_id/content
//      body {content:"<FULL text>",sequence,uuid?} — streaming typewriter
//      updates. The API expects the full accumulated text; when the old text
//      is a prefix of the new one the client extends it with a typewriter
//      effect, so the handle accumulates chunk deltas itself.
//   4. finalize: PATCH /cards/:card_id/settings
//      body {settings:"<stringified {config:{streaming_mode:false}}>"} —
//      cosmetic (swallow errors) — then PUT /cards/:card_id
//      body {card:{type:"card_json",data:"…"},sequence} with the final
//      content. The final PUT is the durable delivery: its failure MUST
//      propagate so the caller (event-forwarder) falls back to the outbox.
//
// `sequence` must be strictly increasing across EVERY operation on the same
// card — one shared counter per handle. Ported pattern from pi-feishu-lark's
// cardkit-stream.ts, corrected to the documented payload shapes.
//
// Interaction-parity extension (docs/UNIFIED-IM-BRIDGE.md): besides the single
// markdown element stream, a handle can drive a WHOLE schema 2.0 card through
// `updateCard` / `finalizeCard` (same PUT /cards/:id endpoint, same monotonic
// sequence). Whole-card pushes are coalesced and rate-gated to one per
// `minPushIntervalMs` (default 800ms) so a busy turn (reasoning deltas + tool
// events) cannot exceed Feishu's chat rate limit. `finalizeCard` cancels any
// pending push, turns streaming OFF, and PUTs the durable final card — its
// failure PROPAGATES so the caller can fall back to the outbox.

import { randomUUID } from "node:crypto";

export interface CardKitApi {
  /** POST /open-apis/cardkit/v1/cards — create a card entity. */
  createCard(payload: unknown): Promise<
    { card_id?: string; data?: { card_id?: string } } | undefined
  >;
  /** im/v1/messages — deliver the card entity into its chat (once per entity). */
  deliverCard(cardId: string): Promise<unknown>;
  /** PUT /cards/:id/elements/:elementId/content — full-text streaming update. */
  streamText(
    cardId: string,
    elementId: string,
    body: { content: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PATCH /cards/:id/settings — e.g. turn streaming_mode off. */
  patchSettings(
    cardId: string,
    body: { settings: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PUT /cards/:id — full card update (final content). */
  updateCard(
    cardId: string,
    body: {
      card: { type: "card_json"; data: string };
      sequence: number;
      uuid: string;
    },
  ): Promise<unknown>;
}

export interface CardKitStreamOptions {
  api: CardKitApi;
  /** Minimum ms between server-side REST API pushes (default 800ms to stay within Feishu chat rate limit). */
  minPushIntervalMs?: number;
  /** ms for client-side typewriter rendering speed in card json (default 120ms). */
  printFrequencyMs?: number;
  /** print_step for the client typewriter (config at create time). */
  printStep?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface CardKitStreamHandle {
  cardId: string;
  /** Append a text delta; the handle sends FULL accumulated text. */
  patch(text: string): Promise<void>;
  /** Finalize: disable streaming, PUT full content. Returns final card id. */
  finalize(fullText: string): Promise<string>;
  /**
   * Whole-card streaming update (PUT /cards/:id with a schema 2.0 card_json).
   * Coalesced + throttled to one push per `minPushIntervalMs`; the LATEST
   * scheduled card always wins. Shares the same monotonic `sequence` counter
   * with the element stream and settings calls. Non-fatal streaming failures
   * surface through `onError`; a card-creation failure disposes the handle.
   */
  updateCard(card: object): Promise<void>;
  /**
   * Finalize a whole-card run card: disable streaming, PUT the final card
   * (the durable delivery). Throws when the final PUT fails so the caller
   * (event-forwarder) can fall back to the transactional outbox.
   */
  finalizeCard(card: object): Promise<string>;
  /** Send a plain-text fallback when cards are unavailable. */
  fallbackText?: (text: string) => Promise<unknown>;
  disposed: boolean;
}

const CARD_SCHEMA = "2.0";
/** element_id of the single markdown element (1–20 chars per API rules). */
const STREAM_ELEMENT_ID = "stream_md";
/** Safety valve: stop patching beyond this many API calls; finalize covers it. */
const MAX_STREAM_PATCHES = 400;
/** Same safety valve for whole-card pushes. */
const MAX_CARD_PATCHES = 400;

export function createCardKitStream(
  opts: CardKitStreamOptions,
): CardKitStreamHandle {
  let cardId: string | undefined;
  let seq = 0; // strictly increasing across ALL ops on this card
  let lastPatchAt = 0;
  let patchCount = 0;
  let disposed = false;
  let inFlight = false;
  let backoffUntil = 0;
  let acc = ""; // accumulated text — the API takes FULL text every push
  // ---- whole-card update state (run card) ----
  let cardPushCount = 0;
  let lastCardPushAt = 0;
  let cardInFlight = false;
  /** Latest card awaiting the rate gate; the newest snapshot always wins. */
  let pendingCard: object | undefined;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last serialized card actually pushed (skips no-op updates). */
  let lastCardData: string | undefined;
  const now = opts.now ?? Date.now;
  const minInterval = opts.minPushIntervalMs ?? opts.printFrequencyMs ?? 800;

  const nextSeq = (): number => {

    seq += 1;
    return seq;
  };

  const isRateLimit = (errText: string): boolean =>
    errText.includes("230020") || errText.includes("rate limit") || errText.includes("429");

  /** Merge a run card's config with the live streaming knobs for creation. */
  const liveCardJson = (card: object): string => {
    const base = card as Record<string, unknown> & { config?: Record<string, unknown> };
    return JSON.stringify({
      ...base,
      config: {
        update_multi: true,
        ...(base.config ?? {}),
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
          print_step: { default: opts.printStep ?? 3 },
          print_strategy: "fast",
        },
      },
    });
  };

  /** Force streaming OFF on the durable final card (the renderer normally does). */
  const finalCardJson = (card: object): string => {
    const base = card as Record<string, unknown> & { config?: Record<string, unknown> };
    return JSON.stringify({
      ...base,
      config: {
        update_multi: true,
        ...(base.config ?? {}),
        streaming_mode: false,
      },
    });
  };

  const extractCardId = (
    res: { card_id?: string; data?: { card_id?: string } } | undefined,
  ): string | undefined => res?.card_id ?? res?.data?.card_id;

  /** The single-markdown-element card JSON used by the original text stream. */
  const cardJson = (text: string, streaming: boolean): string =>
    JSON.stringify({
      schema: CARD_SCHEMA,
      config: {
        update_multi: true,
        ...(streaming
          ? {
              streaming_mode: true,
              streaming_config: {
                print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
                print_step: { default: opts.printStep ?? 3 },
                print_strategy: "fast",
              },
            }
          : {
              streaming_mode: false,
            }),
      },
      body: {
        elements: [
          { tag: "markdown", content: text || " ", element_id: STREAM_ELEMENT_ID },
        ],
      },
    });

  const createPayload = (text: string, streaming: boolean): unknown => ({
    // FLAT body per the official create doc: {type:"card_json", data:"<json>"}
    // — NOT wrapped under a `data` envelope (that shape 400s and the card
    // never appears).
    type: "card_json" as const,
    data: cardJson(text, streaming),
  });

  // ---- whole-card update internals (run card) ------------------------------

  /** Create the card entity from already-serialized run-card JSON, then deliver it. */
  const createCardEntity = async (data: string): Promise<void> => {
    const created = await opts.api.createCard({ type: "card_json" as const, data });
    cardId = extractCardId(created);
    if (!cardId) throw new Error("CardKit create returned no card_id");
    await opts.api.deliverCard(cardId);
    lastCardPushAt = now();
    cardPushCount++;
  };

  const disarmCardTimer = (): void => {
    if (cardTimer === undefined) return;
    clearTimeout(cardTimer);
    cardTimer = undefined;
  };

  /** Push the latest pending card right now (rate/permissions already checked). */
  const flushCardNow = async (): Promise<boolean> => {
    if (disposed || cardId === undefined || cardInFlight) return false;
    if (pendingCard === undefined) return false;
    if (cardPushCount >= MAX_CARD_PATCHES) {
      pendingCard = undefined; // safety valve: finalizeCard lands the final card
      return false;
    }
    const card = pendingCard;
    pendingCard = undefined;
    const data = JSON.stringify(card);
    if (data === lastCardData) return false; // no-op snapshot
    cardInFlight = true;
    lastCardPushAt = now();
    try {
      await opts.api.updateCard(cardId, {
        card: { type: "card_json", data },
        sequence: nextSeq(),
        uuid: randomUUID(),
      });
      lastCardData = data;
      cardPushCount++;
      return true;
    } catch (err) {
      if (isRateLimit(String(err))) backoffUntil = now() + 1500;
      opts.onError?.(err);
      // Non-fatal: finalizeCard still lands the full card.
      return false;
    } finally {
      cardInFlight = false;
    }
  };

  /** Arm the trailing push once the 800ms gate (or a rate-limit backoff) opens. */
  const scheduleCardFlush = (): void => {
    if (disposed || cardTimer !== undefined || pendingCard === undefined) return;
    if (cardPushCount >= MAX_CARD_PATCHES) return;
    const wait = Math.max(
      0,
      minInterval - (now() - lastCardPushAt),
      backoffUntil - now(),
    );
    cardTimer = setTimeout(() => {
      cardTimer = undefined;
      void flushCardNow().then(() => {
        if (pendingCard !== undefined) scheduleCardFlush();
      });
    }, wait);
    // Never keep the process alive just for a pending card snapshot.
    (cardTimer as { unref?: () => void }).unref?.();
  };

  return {
    // Live getters — the closure fields mutate after creation (never snapshot).
    get cardId() {
      return cardId ?? "";
    },
    get disposed() {
      return disposed;
    },
    async patch(text) {
      if (disposed) return;
      acc += text;
      if (cardId === undefined) {
        if (inFlight) return;
        inFlight = true;
        // First chunk: create the streaming entity AND deliver it — an
        // undelivered entity is invisible to the user.
        try {
          const created = await opts.api.createCard(createPayload(acc || " ", true));
          cardId = extractCardId(created);
          if (!cardId) throw new Error("CardKit create returned no card_id");
          await opts.api.deliverCard(cardId);
          patchCount++;
          lastPatchAt = now();
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          return;
        } finally {
          inFlight = false;
        }
        return;
      }

      // Concurrency and rate-limiting gates:
      if (inFlight) return;
      if (patchCount >= MAX_STREAM_PATCHES) return; // finalize covers the rest

      const currentTime = now();
      if (currentTime < backoffUntil) return;
      if (currentTime - lastPatchAt < minInterval) return;

      inFlight = true;
      lastPatchAt = currentTime;
      try {
        await opts.api.streamText(cardId, STREAM_ELEMENT_ID, {
          content: acc,
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
        patchCount++;
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
          backoffUntil = now() + 1500;
        }
        opts.onError?.(err);
        // Non-fatal: finalize still lands the full content.
      } finally {
        inFlight = false;
      }
    },
    async finalize(fullText) {
      if (disposed) {
        if (!cardId) throw new Error("CardKit stream handle was disposed (creation failed)");
        return cardId;
      }
      // Wait for any inFlight network patch to settle before finalizing
      let waitCount = 0;
      while (inFlight && waitCount < 20) {
        await new Promise((r) => setTimeout(r, 50));
        waitCount++;
      }

      const text = fullText || acc;
      if (!cardId) {
        // Never streamed a chunk — create a plain (non-streaming) card with
        // the full content and deliver it. Failure PROPAGATES so the caller
        // falls back to the durable outbox (content must not be lost).
        try {
          const created = await opts.api.createCard(createPayload(text || " ", false));
          cardId = extractCardId(created);
          if (!cardId) throw new Error("CardKit create returned no card_id");
          await opts.api.deliverCard(cardId);
          disposed = true;
          return cardId;
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      const id = cardId;
      // 1) Turn streaming OFF (PATCH settings) — cosmetic, swallow failure.
      try {
        await opts.api.patchSettings(id, {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        opts.onError?.(err);
      }
      // 2) PUT the full content — the durable delivery. Failure propagates.
      try {
        await opts.api.updateCard(id, {
          card: { type: "card_json", data: cardJson(text || " ", false) },
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        // If update failed with rate limit, wait 600ms and retry once
        const errStr = String(err);
        if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            await opts.api.updateCard(id, {
              card: { type: "card_json", data: cardJson(text || " ", false) },
              sequence: nextSeq(),
              uuid: randomUUID(),
            });
            disposed = true;
            return id;
          } catch (retryErr) {
            opts.onError?.(retryErr);
            disposed = true;
            throw retryErr;
          }
        }
        opts.onError?.(err);
        disposed = true;
        throw err;
      }
      disposed = true;
      return id;
    },
    async updateCard(card) {
      if (disposed) return;
      // First whole-card snapshot: create the streaming entity + deliver it.
      if (cardId === undefined) {
        if (cardInFlight) {
          pendingCard = card; // coalesce onto the in-flight creation
          return;
        }
        cardInFlight = true;
        try {
          await createCardEntity(liveCardJson(card));
          // The live-created card already shows this snapshot; remember it so
          // an immediate identical update is not pushed again.
          lastCardData = JSON.stringify(card);
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          return;
        } finally {
          cardInFlight = false;
        }
        if (pendingCard !== undefined) {
          const currentTime = now();
          if (currentTime >= backoffUntil && currentTime - lastCardPushAt >= minInterval) {
            await flushCardNow();
          } else {
            scheduleCardFlush();
          }
        }
        return;
      }

      // Coalesce: only the latest snapshot matters; the 800ms gate is shared.
      pendingCard = card;
      if (cardInFlight) {
        scheduleCardFlush();
        return;
      }
      const currentTime = now();
      if (currentTime >= backoffUntil && currentTime - lastCardPushAt >= minInterval) {
        await flushCardNow();
      }
      if (pendingCard !== undefined) scheduleCardFlush();
    },
    async finalizeCard(card) {
      if (disposed && cardId === undefined) {
        throw new Error("CardKit stream handle was disposed (creation failed)");
      }
      // Cancel any throttled snapshot — the final card supersedes every one.
      disarmCardTimer();
      pendingCard = undefined;
      // Wait for an in-flight network push to settle before replacing the card.
      let waitCount = 0;
      while ((inFlight || cardInFlight) && waitCount < 20) {
        await new Promise((r) => setTimeout(r, 50));
        waitCount++;
      }
      if (cardId === undefined) {
        // Never created (turn had no events or the first snapshot was
        // throttled away): create the final card directly. Failure PROPAGATES
        // so the caller falls back to the durable outbox.
        try {
          await createCardEntity(finalCardJson(card));
          disposed = true;
          const createdId = cardId;
          if (!createdId) throw new Error("CardKit create returned no card_id");
          return createdId;
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      const existingId = cardId;
      if (existingId === undefined) throw new Error("CardKit stream handle has no card");
      if (disposed) return existingId; // already finalized (idempotent)
      const id = existingId;
      const data = finalCardJson(card);
      // 1) Turn streaming OFF (PATCH settings) — cosmetic, swallow failure.
      try {
        await opts.api.patchSettings(id, {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        opts.onError?.(err);
      }
      // 2) PUT the final whole card — the durable delivery. Failure propagates.
      const put = (): Promise<unknown> =>
        opts.api.updateCard(id, {
          card: { type: "card_json", data },
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      try {
        await put();
      } catch (err) {
        // One rate-limit retry, same as the text finalize path.
        if (isRateLimit(String(err))) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            await put();
          } catch (retryErr) {
            opts.onError?.(retryErr);
            disposed = true;
            throw retryErr;
          }
        } else {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      disposed = true;
      return id;
    },
  };

}

export { CARD_SCHEMA, STREAM_ELEMENT_ID };
