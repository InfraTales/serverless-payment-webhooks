/**
 * The webhook body this stack accepts. It follows the common provider shape:
 * a unique event ID, an event type, a creation time, and the object it is about.
 * Amounts are in minor units (cents), so no floating point anywhere.
 */
export interface PaymentEvent {
  id: string;
  type: string;
  created: number;
  data: {
    paymentId: string;
    amount: number;
    currency: string;
    status: string;
  };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * How far along the payment lifecycle a status is. Providers send `created` in
 * whole seconds, so two events for one payment often share a timestamp. When they
 * do, the later step wins. Statuses not listed rank 0 and only win on a newer time.
 */
const STATUS_RANK: Record<string, number> = {
  pending: 1, processing: 1, requires_action: 1,
  succeeded: 2, failed: 2, canceled: 2,
  refunded: 3, disputed: 3,
};

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isWhole = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;

/** Returns the event with only the fields we use, or undefined if any is missing or malformed. */
export function parsePaymentEvent(raw: string): PaymentEvent | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(body) || !isObject(body.data)) return undefined;
  const { id, type, created } = body;
  const { paymentId, amount, currency, status } = body.data;

  const valid =
    isId(id) && isShortString(type, 64) && isWhole(created, 1) &&
    isId(paymentId) && isWhole(amount, 0) &&
    typeof currency === 'string' && /^[a-z]{3}$/.test(currency) &&
    isShortString(status, 32);
  if (!valid) return undefined;

  return { id, type, created, data: { paymentId, amount, currency, status } };
}
