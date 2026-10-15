import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { dynamoApplier, eventBridgePublisher, makeProcessor } from '../../lambda/processor';
import type { PaymentEvent } from '../../lambda/shared/event';
import { FakePayments, FakeStore, paymentEvent, sqsRecord } from '../fakes';

const now = 1_760_000_100;

function setup(publish: jest.Mock<Promise<void>, [PaymentEvent]> = jest.fn(async (_evt: PaymentEvent) => {})) {
  const store = new FakeStore();
  const payments = new FakePayments();
  const handler = makeProcessor({ store, applyEvent: payments.apply, publish, nowSeconds: () => now });
  return { store, payments, publish, handler };
}

describe('processor', () => {
  test('applies, publishes and marks an event done', async () => {
    const { store, payments, publish, handler } = setup();
    const res = await handler({ Records: [sqsRecord(JSON.stringify(paymentEvent()))] });
    expect(res.batchItemFailures).toEqual([]);
    expect(payments.rows.get('pay_1')?.status).toBe('succeeded');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.rows.get('evt_1')?.status).toBe('COMPLETED');
  });

  test('skips an event that is already done', async () => {
    const { store, payments, publish, handler } = setup();
    store.rows.set('evt_1', { status: 'COMPLETED' });
    const res = await handler({ Records: [sqsRecord(JSON.stringify(paymentEvent()))] });
    expect(res.batchItemFailures).toEqual([]);
    expect(payments.writes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  test('retries an event another worker is still processing', async () => {
    const { store, payments, handler } = setup();
    store.rows.set('evt_1', { status: 'IN_PROGRESS', lockExpiresAt: now + 60 });
    const res = await handler({ Records: [sqsRecord(JSON.stringify(paymentEvent()), 'm1')] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(payments.writes).toBe(0);
  });

  test('takes over a lock left by a worker that timed out', async () => {
    const { store, payments, handler } = setup();
    store.rows.set('evt_1', { status: 'IN_PROGRESS', lockExpiresAt: now - 1 });
    expect((await handler({ Records: [sqsRecord(JSON.stringify(paymentEvent()))] })).batchItemFailures).toEqual([]);
    expect(payments.writes).toBe(1);
  });

  test('reports only the failed message, not the whole batch', async () => {
    const publish = jest.fn(async (evt: PaymentEvent) => { if (evt.id === 'evt_2') throw new Error('bus down'); });
    const { store, handler } = setup(publish);
    const records = ['evt_1', 'evt_2', 'evt_3'].map((id, i) =>
      sqsRecord(JSON.stringify(paymentEvent({ id, data: { paymentId: `pay_${i}` } })), `m${i}`));
    const res = await handler({ Records: records });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(store.rows.get('evt_1')?.status).toBe('COMPLETED');
    expect(store.rows.has('evt_2')).toBe(false); // lock released so the retry can claim it
    expect(store.rows.get('evt_3')?.status).toBe('COMPLETED');
  });

  test('does not publish a stale event, but still marks it done', async () => {
    const { store, payments, publish, handler } = setup();
    await payments.apply(paymentEvent({ id: 'evt_new', created: 2_000 }));
    const res = await handler({ Records: [sqsRecord(JSON.stringify(paymentEvent({ id: 'evt_old', created: 1_000 })))] });
    expect(res.batchItemFailures).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(store.rows.get('evt_old')?.status).toBe('COMPLETED');
  });

  test('sends an unparseable message back so it lands in the DLQ', async () => {
    const { handler } = setup();
    expect((await handler({ Records: [sqsRecord('not json', 'bad')] })).batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
  });
});

describe('dynamoApplier', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const apply = dynamoApplier(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'payments');
  beforeEach(() => ddb.reset());

  test('writes with an ordering condition that lets the same event re-apply', async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await apply(paymentEvent())).toBe('applied');
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ paymentId: 'pay_1' });
    expect(input.ConditionExpression).toBe('attribute_not_exists(paymentId) OR lastEventCreated < :created OR lastEventId = :id');
  });

  test("maps a failed condition to 'stale'", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    expect(await apply(paymentEvent())).toBe('stale');
  });
});

describe('eventBridgePublisher', () => {
  const eb = mockClient(EventBridgeClient);
  beforeEach(() => eb.reset());

  test('puts one event with the webhook type as detail-type', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: '1' }] });
    await eventBridgePublisher(new EventBridgeClient({}), 'bus')(paymentEvent({ type: 'payment.failed' }));
    expect(eb.commandCalls(PutEventsCommand)[0].args[0].input.Entries?.[0]).toMatchObject({
      EventBusName: 'bus', Source: 'webhooks.payments', DetailType: 'payment.failed',
    });
  });

  test('throws on a partial failure, which PutEvents reports without throwing', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    await expect(eventBridgePublisher(new EventBridgeClient({}), 'bus')(paymentEvent())).rejects.toThrow('InternalFailure');
  });
});
