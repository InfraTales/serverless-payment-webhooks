/**
 * HMAC-SHA256 webhook signatures, in the same shape most payment providers use:
 *
 *   X-Webhook-Signature: t=<unix seconds>,v1=<hex hmac of "<t>.<raw body>">
 *
 * The timestamp is part of the signed text, so an attacker can't replay an old
 * request with a fresh timestamp. Requests older than the tolerance are rejected.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const TOLERANCE_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Builds a header value. Used by tests and the smoke test to act as the provider. */
export function signatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

/**
 * Checks the header against every accepted secret. Passing two secrets (current and
 * previous) lets you rotate the provider's signing secret without dropping events.
 */
export function verifySignature(
  header: string | undefined,
  rawBody: string,
  secrets: string[],
  nowSeconds: number,
  toleranceSeconds = TOLERANCE_SECONDS,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing' };

  const parts = new Map<string, string[]>();
  for (const item of header.split(',')) {
    const [key, value] = item.trim().split('=', 2);
    if (!key || !value) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }

  const t = Number(parts.get('t')?.[0]);
  const candidates = (parts.get('v1') ?? []).filter((s) => /^[0-9a-f]{64}$/.test(s));
  if (!Number.isInteger(t) || candidates.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: 'stale' };

  for (const secret of secrets.filter(Boolean)) {
    const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
    for (const candidate of candidates) {
      // Constant-time compare, so response timing doesn't leak how many bytes matched.
      if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) return { ok: true };
    }
  }
  return { ok: false, reason: 'mismatch' };
}
