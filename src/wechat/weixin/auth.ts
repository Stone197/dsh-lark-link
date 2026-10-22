// Ported from pan17/dsh-wechat v0.13.3 (MIT) — WeChat channel of the
// unified dsh-lark-link plugin. Channel-internal paths unchanged; see
// docs/UNIFIED-IM-BRIDGE.md for the contract and ownership.

/**
 * WeChat QR login flow + token persistence.
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import fs from "node:fs";
import path from "node:path";
import { getBotQrcode, getQrcodeStatus } from "./api.ts";
import { ensurePrivateDir, writePrivateFile } from "../utils/secure-fs.ts";

export interface TokenData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

function getAuthDir(storageDir: string): string {
  return path.join(storageDir, "auth");
}

function getTokenPath(storageDir: string): string {
  return path.join(getAuthDir(storageDir), "token.json");
}

/** Thrown when plugin dispose / relogin cancels the QR login flow. */
function abortError(): Error {
  const err = new Error("login aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Sleep that also honours an abort signal.
 *
 * The QR loop waits 1.5s between polls. A plain `setTimeout` would (a) keep
 * the process alive for up to that delay after the plugin is disposed and
 * (b) make `bridge.stop()` — which AWAITS the login task — take that long.
 * `unref()` + abort listener keep dispose bounded to a microtask.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function loadToken(storageDir: string): TokenData | null {
  const tokenPath = getTokenPath(storageDir);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(storageDir: string, data: TokenData): void {
  const authDir = getAuthDir(storageDir);
  ensurePrivateDir(authDir);
  const tokenPath = getTokenPath(storageDir);
  // 0o600 (dir 0o700): this file IS the bot credential — anyone who can read
  // it can send messages as the bot. On Windows Node ignores the mode and the
  // inherited `%USERPROFILE%` ACLs apply (see src/utils/secure-fs.ts).
  writePrivateFile(tokenPath, JSON.stringify(data, null, 2));
}

export async function login(params: {
  baseUrl: string;
  botType?: string;
  storageDir: string;
  log: (msg: string) => void;
  renderQrUrl?: (url: string) => void;
  /** Cancels the QR poll when the plugin is disposed / a relogin supersedes it. */
  signal?: AbortSignal;
}): Promise<TokenData> {
  const { baseUrl, botType, storageDir, log, renderQrUrl, signal } = params;

  log("Starting WeChat QR login...");

  if (signal?.aborted) throw abortError();
  const qrResp = await getBotQrcode({ baseUrl, botType, abortSignal: signal });
  const qrcodeUrl = qrResp.qrcode_img_content;

  log("Please scan the QR code with WeChat:");
  if (renderQrUrl) {
    renderQrUrl(qrcodeUrl);
  } else {
    log(`QR URL: ${qrcodeUrl}`);
  }

  const deadline = Date.now() + 5 * 60_000;
  let currentQrcode = qrResp.qrcode;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const statusResp = await getQrcodeStatus({ baseUrl, qrcode: currentQrcode, abortSignal: signal });

    switch (statusResp.status) {
      case "wait":
        break;
      case "scaned":
        log("QR scanned, please confirm in WeChat...");
        break;
      case "expired": {
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("QR code expired multiple times, please retry");
        }
        log(`QR expired, refreshing (${refreshCount}/3)...`);
        const newQr = await getBotQrcode({ baseUrl, botType, abortSignal: signal });
        currentQrcode = newQr.qrcode;
        if (renderQrUrl) {
          renderQrUrl(newQr.qrcode_img_content);
        } else {
          log(`New QR URL: ${newQr.qrcode_img_content}`);
        }
        break;
      }
      case "confirmed": {
        log("Login successful!");
        const tokenData: TokenData = {
          token: statusResp.bot_token!,
          baseUrl: statusResp.baseurl || baseUrl,
          accountId: statusResp.ilink_bot_id!,
          userId: statusResp.ilink_user_id!,
          savedAt: new Date().toISOString(),
        };
        saveToken(storageDir, tokenData);
        log(`Bot ID: ${tokenData.accountId}`);
        log(`Token saved to ${getTokenPath(storageDir)}`);
        return tokenData;
      }
    }

    await sleep(1500, signal);
  }

  throw new Error("Login timeout (5 minutes)");
}
