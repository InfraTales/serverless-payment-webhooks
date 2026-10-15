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

export function parsePaymentEvent(raw: string): PaymentEvent | undefined {
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const d = body?.data;
  const valid =
    typeof body?.id === 'string' && ID.test(body.id) &&
    typeof body.type === 'string' && body.type.length <= 64 &&
    Number.isInteger(body.created) && body.created > 0 &&
    typeof d?.paymentId === 'string' && ID.test(d.paymentId) &&
    Number.isInteger(d.amount) && d.amount >= 0 &&
    typeof d.currency === 'string' && /^[a-z]{3}$/.test(d.currency) &&
    typeof d.status === 'string' && d.status.length <= 32;
  if (!valid) return undefined;

  return {
    id: body.id,
    type: body.type,
    created: body.created,
    data: { paymentId: d.paymentId, amount: d.amount, currency: d.currency, status: d.status },
  };
}
