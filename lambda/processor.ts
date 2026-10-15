/**
 * Queue consumer. SQS and the provider both deliver at least once, so every
 * event goes through the idempotency store before it touches payment state.
 *
 * Failures are reported per message (ReportBatchItemFailures). One bad message
 * is retried on its own instead of sending the whole batch back to the queue.
 */
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoIdempotencyStore, IdempotencyStore } from './shared/idempotency';
import { parsePaymentEvent, PaymentEvent, statusRank } from './shared/event';
import { requireEnv } from './shared/env';

export type ApplyResult = 'applied' | 'stale';

export interface ProcessorDeps {
  store: IdempotencyStore;
  /** Writes the payment's new state. Returns 'stale' when a newer event already won. */
  applyEvent: (evt: PaymentEvent) => Promise<ApplyResult>;
  publish: (evt: PaymentEvent) => Promise<void>;
  nowSeconds: () => number;
}

export class BusyError extends Error {}

export function makeProcessor(deps: ProcessorDeps) {
  async function processRecord(record: SQSRecord): Promise<void> {
    const evt = parsePaymentEvent(record.body);
    if (!evt) {
      // The receiver already validated this, so a bad body here is a bug. Let it go to the DLQ.
      throw new Error(`unparseable message ${record.messageId}`);
    }

    const claim = await deps.store.claim(evt.id, deps.nowSeconds());
    if (claim === 'done') {
      console.log(JSON.stringify({ msg: 'duplicate skipped', eventId: evt.id }));
      return;
    }
    if (claim === 'busy') throw new BusyError(`event ${evt.id} is being processed by another worker`);

    try {
      const result = await deps.applyEvent(evt);
      if (result === 'applied') await deps.publish(evt);
      else console.log(JSON.stringify({ msg: 'stale event ignored', eventId: evt.id, paymentId: evt.data.paymentId }));
      await deps.store.complete(evt.id, deps.nowSeconds());
    } catch (err) {
      await deps.store.release(evt.id);
      throw err;
    }
  }

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record);
      } catch (err) {
        console.error(JSON.stringify({ msg: 'record failed', messageId: record.messageId, error: String(err) }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

// ---------- wiring for the real Lambda ----------

/**
 * Providers don't promise order. The condition keeps a late "payment.processing"
 * from overwriting an earlier-delivered "payment.succeeded":
 *   - a newer `created` wins,
 *   - on the same second, the later lifecycle step wins (see statusRank),
 *   - the same event ID may re-apply, so a retry after a failed publish still goes through.
 */
export const APPLY_CONDITION =
  'attribute_not_exists(paymentId) OR lastEventId = :id OR lastEventCreated < :created' +
  ' OR (lastEventCreated = :created AND statusRank < :rank)';

export function dynamoApplier(doc: DynamoDBDocumentClient, tableName: string) {
  return async (evt: PaymentEvent): Promise<ApplyResult> => {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { paymentId: evt.data.paymentId },
          UpdateExpression:
            'SET #s = :status, statusRank = :rank, amount = :amount, currency = :currency, lastEventId = :id, lastEventCreated = :created',
          ConditionExpression: APPLY_CONDITION,
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':status': evt.data.status,
            ':rank': statusRank(evt.data.status),
            ':amount': evt.data.amount,
            ':currency': evt.data.currency,
            ':id': evt.id,
            ':created': evt.created,
          },
        }),
      );
      return 'applied';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'stale';
      throw err;
    }
  };
}

export function eventBridgePublisher(client: EventBridgeClient, busName: string) {
  return async (evt: PaymentEvent): Promise<void> => {
    const res = await client.send(
      new PutEventsCommand({
        Entries: [{ EventBusName: busName, Source: 'webhooks.payments', DetailType: evt.type, Detail: JSON.stringify(evt) }],
      }),
    );
    // PutEvents can partly fail without throwing.
    if (res.FailedEntryCount) throw new Error(`PutEvents failed: ${res.Entries?.[0]?.ErrorCode}`);
  };
}

const ddb = new DynamoDBClient({});

export const handler = makeProcessor({
  store: DynamoIdempotencyStore.fromEnv(ddb),
  applyEvent: dynamoApplier(DynamoDBDocumentClient.from(ddb), requireEnv('PAYMENTS_TABLE')),
  publish: eventBridgePublisher(new EventBridgeClient({}), requireEnv('EVENT_BUS_NAME')),
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
