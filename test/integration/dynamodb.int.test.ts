/**
 * Runs the real condition expressions against DynamoDB Local.
 *
 * The unit tests check that we send the right expression. These check that the
 * expression does what we think it does, including when several workers race.
 * Start DynamoDB Local and set DYNAMODB_ENDPOINT (see README, "Tests").
 */
import { randomUUID } from 'crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoIdempotencyStore } from '../../lambda/shared/idempotency';
import { dynamoApplier, makeProcessor } from '../../lambda/processor';
import type { PaymentEvent } from '../../lambda/shared/event';
import { paymentEvent, sqsRecord } from '../fakes';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint) throw new Error('Set DYNAMODB_ENDPOINT, for example http://localhost:8000');

const client = new DynamoDBClient({ endpoint, region: 'us-east-1' });
const doc = DynamoDBDocumentClient.from(client);
const eventsTable = `events-${randomUUID()}`;
const paymentsTable = `payments-${randomUUID()}`;
const now = 1_760_000_000;

const store = new DynamoIdempotencyStore(doc, { tableName: eventsTable, lockSeconds: 120, retentionSeconds: 30 * 86400 });
const apply = dynamoApplier(doc, paymentsTable);

async function createTable(name: string, key: string) {
  await client.send(new CreateTableCommand({
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
    KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
  }));
}

const eventRow = async (eventId: string) => (await doc.send(new GetCommand({ TableName: eventsTable, Key: { eventId } }))).Item;
const payment = async (paymentId: string) => (await doc.send(new GetCommand({ TableName: paymentsTable, Key: { paymentId } }))).Item;
const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await createTable(eventsTable, 'eventId');
  await createTable(paymentsTable, 'paymentId');
});

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: eventsTable }));
  await client.send(new DeleteTableCommand({ TableName: paymentsTable }));
  client.destroy();
});

describe('idempotency store on DynamoDB', () => {
  test('claim, then busy, then done after complete', async () => {
    const e = id('evt');
    expect(await store.claim(e, now)).toBe('claimed');
    expect(await store.claim(e, now + 1)).toBe('busy');
    await store.complete(e, now + 2);
    expect(await store.claim(e, now + 3)).toBe('done');
    expect(await eventRow(e)).toMatchObject({ status: 'COMPLETED', expiresAt: now + 2 + 30 * 86400 });
    expect((await eventRow(e))?.lockExpiresAt).toBeUndefined();
  });

  test('a lock is held until it expires, then another worker can take it', async () => {
    const e = id('evt');
    await store.claim(e, now);
    expect(await store.claim(e, now + 120)).toBe('busy'); // lockExpiresAt = now + 120, condition is strict "<"
    expect(await store.claim(e, now + 121)).toBe('claimed');
  });

  test('a completed event is never claimed again, however old', async () => {
    const e = id('evt');
    await store.claim(e, now);
    await store.complete(e, now);
    expect(await store.claim(e, now + 10 * 86400)).toBe('done');
  });

  test('release frees an in-progress claim but never deletes a completed one', async () => {
    const a = id('evt');
    await store.claim(a, now);
    await store.release(a);
    expect(await eventRow(a)).toBeUndefined();

    const b = id('evt');
    await store.claim(b, now);
    await store.complete(b, now);
    await store.release(b);
    expect(await eventRow(b)).toMatchObject({ status: 'COMPLETED' });
  });

  test('20 workers racing for one event: exactly one wins', async () => {
    const e = id('evt');
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(e, now)));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'busy')).toHaveLength(19);
  });
});

describe('payment state on DynamoDB', () => {
  const evt = (paymentId: string, eventId: string, created: number, status: string): PaymentEvent =>
    paymentEvent({ id: eventId, type: `payment.${status}`, created, data: { paymentId, status } });

  test('a newer event replaces an older one, an older one is ignored', async () => {
    const p = id('pay');
    expect(await apply(evt(p, 'evt_a', 100, 'processing'))).toBe('applied');
    expect(await apply(evt(p, 'evt_b', 200, 'succeeded'))).toBe('applied');
    expect(await apply(evt(p, 'evt_c', 150, 'processing'))).toBe('stale');
    expect(await payment(p)).toMatchObject({ status: 'succeeded', lastEventId: 'evt_b', lastEventCreated: 200 });
  });

  test('the same event can be applied again, so a retry after a failed publish goes through', async () => {
    const p = id('pay');
    await apply(evt(p, 'evt_a', 100, 'succeeded'));
    expect(await apply(evt(p, 'evt_a', 100, 'succeeded'))).toBe('applied');
  });

  // Providers send `created` in whole seconds, so two events for one payment often share it.
  test('same second: the later lifecycle step wins, whichever arrives first', async () => {
    const forward = id('pay');
    expect(await apply(evt(forward, 'evt_a', 100, 'processing'))).toBe('applied');
    expect(await apply(evt(forward, 'evt_b', 100, 'succeeded'))).toBe('applied');
    expect((await payment(forward))?.status).toBe('succeeded');

    const backward = id('pay');
    expect(await apply(evt(backward, 'evt_b', 100, 'succeeded'))).toBe('applied');
    expect(await apply(evt(backward, 'evt_a', 100, 'processing'))).toBe('stale');
    expect((await payment(backward))?.status).toBe('succeeded');
  });

  test('same second, same step: the first one written stays', async () => {
    const p = id('pay');
    await apply(evt(p, 'evt_a', 100, 'succeeded'));
    expect(await apply(evt(p, 'evt_b', 100, 'failed'))).toBe('stale');
    expect((await payment(p))?.lastEventId).toBe('evt_a');
  });
});

describe('processor on DynamoDB', () => {
  test('the same event delivered to 10 concurrent invocations is published once', async () => {
    const published: string[] = [];
    const handler = makeProcessor({
      store,
      applyEvent: apply,
      publish: async (e) => { published.push(e.id); },
      nowSeconds: () => now,
    });
    const body = JSON.stringify(paymentEvent({ id: id('evt'), data: { paymentId: id('pay') } }));

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => handler({ Records: [sqsRecord(body, `m${i}`)] })));

    expect(published).toHaveLength(1);
    // The losers saw a live lock and asked SQS to retry. On retry they find the event done.
    expect(results.flatMap((r) => r.batchItemFailures)).toHaveLength(9);
    const retries = await handler({ Records: [sqsRecord(body, 'retry')] });
    expect(retries.batchItemFailures).toEqual([]);
    expect(published).toHaveLength(1);
  });
});
