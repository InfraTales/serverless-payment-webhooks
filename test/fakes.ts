/**
 * In-memory stand-ins that follow the same rules as the DynamoDB conditions in
 * lambda/shared/idempotency.ts and lambda/processor.ts. The flow tests run the
 * real handlers against these.
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type { ClaimResult, IdempotencyStore } from '../lambda/shared/idempotency';
import type { ApplyResult } from '../lambda/processor';
import type { PaymentEvent } from '../lambda/shared/event';

export class FakeStore implements IdempotencyStore {
  rows = new Map<string, { status: 'IN_PROGRESS' | 'COMPLETED'; lockExpiresAt?: number }>();
  constructor(private lockSeconds = 120) {}

  async claim(eventId: string, now: number): Promise<ClaimResult> {
    const row = this.rows.get(eventId);
    if (!row || (row.status === 'IN_PROGRESS' && row.lockExpiresAt! < now)) {
      this.rows.set(eventId, { status: 'IN_PROGRESS', lockExpiresAt: now + this.lockSeconds });
      return 'claimed';
    }
    return row.status === 'COMPLETED' ? 'done' : 'busy';
  }
  async complete(eventId: string): Promise<void> {
    this.rows.set(eventId, { status: 'COMPLETED' });
  }
  async release(eventId: string): Promise<void> {
    if (this.rows.get(eventId)?.status === 'IN_PROGRESS') this.rows.delete(eventId);
  }
}

export class FakePayments {
  rows = new Map<string, { status: string; amount: number; lastEventId: string; lastEventCreated: number }>();
  writes = 0;

  apply = async (evt: PaymentEvent): Promise<ApplyResult> => {
    const row = this.rows.get(evt.data.paymentId);
    if (row && !(row.lastEventCreated < evt.created || row.lastEventId === evt.id)) return 'stale';
    this.writes++;
    this.rows.set(evt.data.paymentId, {
      status: evt.data.status,
      amount: evt.data.amount,
      lastEventId: evt.id,
      lastEventCreated: evt.created,
    });
    return 'applied';
  };
}

/** A queue that keeps message bodies so the flow tests can hand them to the processor. */
export class FakeQueue {
  messages: { eventId: string; body: string }[] = [];
  enqueue = async (eventId: string, body: string) => {
    this.messages.push({ eventId, body });
  };
  drain(): SQSEvent {
    const Records = this.messages.map((m, i) => sqsRecord(m.body, `msg-${i}`));
    this.messages = [];
    return { Records };
  }
}

export function sqsRecord(body: string, messageId = 'msg-1'): SQSRecord {
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body,
    attributes: {} as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:webhooks',
    awsRegion: 'us-east-1',
  };
}

type EventOverrides = Partial<Omit<PaymentEvent, 'data'>> & { data?: Partial<PaymentEvent['data']> };

export function paymentEvent(overrides: EventOverrides = {}): PaymentEvent {
  return {
    id: 'evt_1',
    type: 'payment.succeeded',
    created: 1_760_000_000,
    ...(({ data, ...rest }) => rest)(overrides),
    data: { paymentId: 'pay_1', amount: 4999, currency: 'usd', status: 'succeeded', ...overrides.data },
  };
}
