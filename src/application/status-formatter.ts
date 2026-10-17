// StatusFormatter: pure functions turning BridgeStatus into user-facing
// status lines (Feishu text / GUI panel). Harness-agnostic.

import type { BridgeStatus } from "../common/types.ts";

export function formatStatusLine(s: BridgeStatus): string {
  const conn = s.connState.toUpperCase();
  const parts = [
    `连接: ${conn}${s.wsReady ? " (WS)" : ""}`,
    `outbox: ${s.outboxPending} 待发 / ${s.outboxFailed} 失败`,
    `会话: ${s.sessions}`,
  ];
  if (s.inboundPending > 0)
    parts.push(`补发: ${s.inboundPending} 条未完成`);
  if (s.inboundFailed > 0)
    parts.push(`补发失败: ${s.inboundFailed} 条`);
  if (s.quarantinedUntil) {
    const mins = Math.ceil((s.quarantinedUntil - Date.now()) / 60_000);
    parts.push(`熔断: ${Math.max(0, mins)}min 后重试`);
  }
  if (s.lastError) parts.push(`最近错误: ${s.lastError}`);
  return parts.join(" · ");
}

export function statusDetailLines(s: BridgeStatus): string[] {
  const lines = [
    `状态: ${s.connState}`,
    `WS 就绪: ${s.wsReady}`,
    `上次探活: ${s.lastProbeAt ? new Date(s.lastProbeAt).toISOString() : "—"} (${s.lastProbeOk === undefined ? "?" : s.lastProbeOk ? "正常" : "失败"})`,
    `outbox 待发: ${s.outboxPending}`,
    `outbox 失败: ${s.outboxFailed}`,
    `入站补发待处理: ${s.inboundPending}`,
    `入站补发失败: ${s.inboundFailed}`,
    `活跃会话: ${s.sessions}`,
  ];
  if (s.connectedAt) lines.push(`连接时间: ${new Date(s.connectedAt).toISOString()}`);
  if (s.quarantinedUntil) lines.push(`熔断至: ${new Date(s.quarantinedUntil).toISOString()} (${s.quarantinedReason ?? ""})`);
  if (s.owner) lines.push(`持有者: pid ${s.owner.pid} @ ${s.owner.host} (${new Date(s.owner.startedAt).toISOString()})`);
  return lines;
}

/** Mask secrets in a diagnostics dump (config/credentials redaction). */
export function redactSecrets(input: string, secrets: string[] = []): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    out = out.split(secret).join("***");
  }
  // 1. Authorization Bearer tokens
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{12,}/gi, "$1***");
  // 2. Secret assignments: app_secret, encrypt_key, api_key, token, password, etc.
  out = out.replace(
    /(["']?(?:app_?secret|encrypt_?key|verification_?token|access_?token|api_?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',;}{]{8,}(["']?)/gi,
    "$1***$2",
  );
  // 3. Provider keys: sk-...
  out = out.replace(/\bsk-[A-Za-z0-9_\-]{16,}\b/g, "sk-***");
  // 4. Feishu tokens: t-... or u-...
  out = out.replace(/\b(?:t|u)-[A-Za-z0-9_\-]{20,}\b/g, "***");
  // 5. Generic 32+ hex/base64-ish tokens
  out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, "***");
  return out;
}

/**
 * Truncate a string to fit within maxBytes of UTF-8 encoding without splitting
 * multi-byte characters or surrogate pairs (e.g. emojis / CJK characters).
 */
export function boundedUtf8String(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let truncated = buf.subarray(0, maxBytes).toString("utf8");
  truncated = truncated.replace(/\uFFFD+$/, "");
  return truncated;
}
