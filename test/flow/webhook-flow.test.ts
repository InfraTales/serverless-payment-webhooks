/**
 * End to end through the real receiver and processor, with in-memory fakes for
 * SQS and DynamoDB. Each test is a delivery pattern payment providers really produce.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { makeReceiver } from '../../lambda/receiver';
import { makeProcessor } from '../../lambda/processor';
import { signatureHeader } from '../../lambda/shared/signature';
import type { PaymentEvent } from '../../lambda/shared/event';
import { FakePayments, FakeQueue, FakeStore, paymentEvent } from '../fakes';

const secret = 'whsec_flow';

function system() {
  let clock = 1_760_000_000;
  const queue = new FakeQueue();
  const store = new FakeStore(120);
  const payments = new FakePayments();
  const published: PaymentEvent[] = [];
  let publishFailures = 0;

  const receive = makeReceiver({ getSecrets: async () => [secret], enqueue: queue.enqueue, nowSeconds: () => clock });
  const process = makeProcessor({
    store,
    applyEvent: payments.apply,
    publish: async (evt) => {
      if (publishFailures > 0) { publishFailures--; throw new Error('EventBridge throttled'); }
      published.push(evt);
    },
    nowSeconds: () => clock,
  });

  /** What the provider does: sign the raw body with the current time and POST it. */
  async function deliver(evt: PaymentEvent): Promise<number> {
    const body = JSON.stringify(evt);
    const req = {
      body,
      isBase64Encoded: false,
      headers: { 'x-webhook-signature': signatureHeader(secret, clock, body) },
      requestContext: { requestId: 'r' },
    } as unknown as APIGatewayProxyEventV2;
    return ((await receive(req)) as APIGatewayProxyStructuredResultV2).statusCode!;
  }

  return {
    queue, store, payments, published, deliver,
    drain: () => process(queue.drain()),
    tick: (s: number) => { clock += s; },
    failNextPublishes: (n: number) => { publishFailures = n; },
  };
}

test('a provider retry after a slow 200 is processed once', async () => {
  const s = system();
  const evt = paymentEvent();
  expect(await s.deliver(evt)).toBe(200);
  s.tick(30);
  expect(await s.deliver(evt)).toBe(200); // provider timed out on its side and sent it again
  await s.drain();

  expect(s.payments.writes).toBe(1);
  expect(s.published).toHaveLength(1);
});

test('the same event twice in one batch is processed once', async () => {
  const s = system();
  await s.deliver(paymentEvent());
  await s.deliver(paymentEvent());
  const res = await s.drain();

  expect(res.batchItemFailures).toEqual([]);
  expect(s.published).toHaveLength(1);
});

test('a retry three days later is still a duplicate', async () => {
  const s = system();
  await s.deliver(paymentEvent());
  await s.drain();
  s.tick(3 * 86400);
  await s.deliver(paymentEvent());
  await s.drain();

  expect(s.published).toHaveLength(1);
});

test('events arriving out of order leave the newest state in place', async () => {
  const s = system();
  const processing = paymentEvent({ id: 'evt_a', type: 'payment.processing', created: 100, data: { status: 'processing' } });
  const succeeded = paymentEvent({ id: 'evt_b', type: 'payment.succeeded', created: 200, data: { status: 'succeeded' } });

  await s.deliver(succeeded);
  await s.drain();
  await s.deliver(processing); // the older event shows up late
  await s.drain();

  expect(s.payments.rows.get('pay_1')?.status).toBe('succeeded');
  expect(s.published.map((e) => e.id)).toEqual(['evt_b']);
});

test('a failed publish is retried without writing the payment twice in a different state', async () => {
  const s = system();
  s.failNextPublishes(1);
  await s.deliver(paymentEvent());
  const msgs = [...s.queue.messages];

  const first = await s.drain();
  expect(first.batchItemFailures).toHaveLength(1);
  expect(s.published).toHaveLength(0);

  // SQS makes the message visible again; the retry re-applies the same event and publishes.
  s.queue.messages = msgs;
  const second = await s.drain();
  expect(second.batchItemFailures).toEqual([]);
  expect(s.published).toHaveLength(1);
  expect(s.payments.rows.get('pay_1')?.lastEventId).toBe('evt_1');
});

test('a worker that died holding the lock does not block the event forever', async () => {
  const s = system();
  await s.deliver(paymentEvent());
  const msgs = [...s.queue.messages];
  // Simulate a worker that claimed the event and then timed out before finishing.
  await s.store.claim('evt_1', 1_760_000_000);

  expect((await s.drain()).batchItemFailures).toHaveLength(1); // lock still live: try later

  s.tick(180); // visibility timeout passes, lock (120 s) has expired
  s.queue.messages = msgs;
  expect((await s.drain()).batchItemFailures).toEqual([]);
  expect(s.published).toHaveLength(1);
});

test('a forged webhook never reaches the queue', async () => {
  const s = system();
  const body = JSON.stringify(paymentEvent({ data: { amount: 1 } }));
  const forged = {
    body,
    isBase64Encoded: false,
    headers: { 'x-webhook-signature': signatureHeader('guessed-secret', 1_760_000_000, body) },
    requestContext: { requestId: 'r' },
  } as unknown as APIGatewayProxyEventV2;
  const receive = makeReceiver({ getSecrets: async () => [secret], enqueue: s.queue.enqueue, nowSeconds: () => 1_760_000_000 });

  expect(((await receive(forged)) as APIGatewayProxyStructuredResultV2).statusCode).toBe(401);
  expect(s.queue.messages).toHaveLength(0);
});
