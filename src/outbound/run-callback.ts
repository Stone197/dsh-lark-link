// Signed callback tokens for buttons embedded in the live run card.
//
// A CardKit button `value` travels through Feishu's card.action.trigger
// webhook. Without an authenticity check, a crafted/replayed callback could
// stop someone else's run. This module mirrors the bridge's callback-auth
// design (HMAC over a compact base64url payload, TTL, one-shot nonce) but is
// scoped to the run-card stop action.
//
// The production wiring (src/index.ts, owned elsewhere) verifies the token
// before honoring `op:"stop"`; when no token is configured the button still
// works via the legacy bare `op:"stop"` path (no forgery protection).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** What a signed stop callback proves. */
export interface StopCallbackClaims {
  /** Conversation/session key the card belongs to. */
  sessionKey: string;
  /** Chat the card was delivered to. */
  chatId: string;
  /** Clicking operator open_id (bound at verify time, not sign time). */
  action: "stop";
  /** Expiry (epoch ms). */
  exp: number;
  /** One-shot nonce (replay protection). */
  nonce: string;
}

export interface StopCallbackAuthOptions {
  /** HMAC secret (the Feishu app secret is what the bridge already holds). */
  secret: string;
  /** Token lifetime, default 24h (a run card lives at most one turn). */
  ttlMs?: number;
  now?: () => number;
  createNonce?: () => string;
}

export interface StopCallbackSignInput {
  sessionKey: string;
  chatId: string;
}

export type StopCallbackVerifyResult =
  | { ok: true; claims: StopCallbackClaims }
  | {
      ok: false;
      reason: "malformed" | "bad-signature" | "expired" | "context-mismatch" | "nonce-replay";
    };

export interface StopCallbackAuth {
  /** Sign a stop action for one card/chat. */
  sign(input: StopCallbackSignInput): string;
  /** Verify a token from `value.token`, binding it to the clicked chat/session. */
  verify(
    token: string,
    expected: { sessionKey?: string; chatId: string },
  ): StopCallbackVerifyResult;
  /** Test/diagnostic hook — number of consumed nonces retained. */
  nonceCount(): number;
}

const PREFIX = "runcb.v1";
/** How long consumed nonces are remembered (>= token TTL so replay can't outlive it). */
const NONCE_RETENTION_MS = 25 * 60 * 60 * 1000;

export function createStopCallbackAuth(
  options: StopCallbackAuthOptions,
): StopCallbackAuth {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const createNonce = options.createNonce ?? (() => randomBytes(16).toString("base64url"));
  /** nonce → expiry; consumed nonces stay until they expire (minus a margin). */
  const usedNonces = new Map<string, number>();

  const pruneNonces = (): void => {
    const cutoff = now() - NONCE_RETENTION_MS;
    for (const [nonce, at] of usedNonces) {
      if (at < cutoff) usedNonces.delete(nonce);
    }
  };

  const signature = (encoded: string): string =>
    createHmac("sha256", options.secret).update(encoded).digest("base64url");

  return {
    sign(input) {
      const payload: StopCallbackClaims = {
        sessionKey: input.sessionKey,
        chatId: input.chatId,
        action: "stop",
        exp: now() + ttlMs,
        nonce: createNonce(),
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${PREFIX}.${encoded}.${signature(encoded)}`;
    },

    verify(token, expected) {
      const parts = token.split(".");
      // PREFIX itself contains a dot (`runcb.v1`), so a valid token has 4 parts.
      if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
        return { ok: false, reason: "malformed" };
      }
      const encoded = parts[2];
      const actual = parts[3];
      if (!encoded || !actual) return { ok: false, reason: "malformed" };

      const claims = decodeClaims(encoded);
      if (!claims) return { ok: false, reason: "malformed" };

      if (!signatureMatches(actual, signature(encoded))) {
        return { ok: false, reason: "bad-signature" };
      }
      if (claims.exp <= now()) return { ok: false, reason: "expired" };
      if (claims.action !== "stop") return { ok: false, reason: "context-mismatch" };
      if (expected.chatId !== "" && claims.chatId !== expected.chatId) {
        return { ok: false, reason: "context-mismatch" };
      }
      if (expected.sessionKey !== undefined && claims.sessionKey !== expected.sessionKey) {
        return { ok: false, reason: "context-mismatch" };
      }

      pruneNonces();
      if (usedNonces.has(claims.nonce)) return { ok: false, reason: "nonce-replay" };
      usedNonces.set(claims.nonce, now());
      return { ok: true, claims };
    },

    nonceCount() {
      return usedNonces.size;
    },
  };
}

function decodeClaims(encoded: string): StopCallbackClaims | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<StopCallbackClaims>;
    if (
      typeof raw.sessionKey !== "string" ||
      typeof raw.chatId !== "string" ||
      raw.action !== "stop" ||
      typeof raw.exp !== "number" ||
      typeof raw.nonce !== "string"
    ) {
      return undefined;
    }
    return {
      sessionKey: raw.sessionKey,
      chatId: raw.chatId,
      action: "stop",
      exp: raw.exp,
      nonce: raw.nonce,
    };
  } catch {
    return undefined;
  }
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
