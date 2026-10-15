import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { cachedSecretLoader, makeReceiver, MAX_BODY_BYTES } from '../../lambda/receiver';
import { signatureHeader } from '../../lambda/shared/signature';
import { FakeQueue, paymentEvent } from '../fakes';

const secret = 'whsec_test';
const now = 1_760_000_000;

function request(body: string | Buffer, header?: string, base64 = false): APIGatewayProxyEventV2 {
  return {
    body: base64 ? Buffer.from(body).toString('base64') : body.toString(),
    isBase64Encoded: base64,
    headers: header ? { 'x-webhook-signature': header } : {},
    requestContext: { requestId: 'req-1' },
  } as unknown as APIGatewayProxyEventV2;
}

function setup() {
  const queue = new FakeQueue();
  const handler = makeReceiver({ getSecrets: async () => [secret], enqueue: queue.enqueue, nowSeconds: () => now });
  const call = async (e: APIGatewayProxyEventV2) => (await handler(e)) as APIGatewayProxyStructuredResultV2;
  return { queue, call };
}

describe('receiver', () => {
  test('queues a signed event and answers 200', async () => {
    const { queue, call } = setup();
    const body = JSON.stringify(paymentEvent());
    const res = await call(request(body, signatureHeader(secret, now, body)));
    expect(res.statusCode).toBe(200);
    expect(queue.messages).toEqual([{ eventId: 'evt_1', body }]);
  });

  test('passes the exact raw body through, byte for byte', async () => {
    const { queue, call } = setup();
    const body = `{ "id": "evt_1", "type": "payment.succeeded", "created": ${now},\n "data": {"paymentId":"pay_1","amount":1,"currency":"usd","status":"succeeded"} }`;
    await call(request(body, signatureHeader(secret, now, body)));
    expect(queue.messages[0].body).toBe(body);
  });

  test('decodes a base64 body before checking the signature', async () => {
    const { call } = setup();
    const body = JSON.stringify(paymentEvent());
    expect((await call(request(body, signatureHeader(secret, now, body), true))).statusCode).toBe(200);
  });

  test('rejects an unsigned request with 401 and queues nothing', async () => {
    const { queue, call } = setup();
    const res = await call(request(JSON.stringify(paymentEvent())));
    expect(res.statusCode).toBe(401);
    expect(queue.messages).toHaveLength(0);
  });

  test('does not tell the caller why the signature failed', async () => {
    const { call } = setup();
    const body = JSON.stringify(paymentEvent());
    const res = await call(request(body, signatureHeader(secret, now - 3600, body)));
    expect(res.body).toBe(JSON.stringify({ error: 'invalid signature' }));
  });

  test('verifies the signature over the decoded bytes, not a re-encoded string', async () => {
    const { queue, call } = setup();
    const body = Buffer.from(JSON.stringify(paymentEvent({ data: { status: 'succeeded' } })).replace('usd', 'eur'), 'utf8');
    expect((await call(request(body, signatureHeader(secret, now, body), true))).statusCode).toBe(200);
    expect(queue.messages[0].body).toBe(body.toString('utf8'));
  });

  test('rejects a correctly signed body that is not valid UTF-8 with 400', async () => {
    const { queue, call } = setup();
    const json = Buffer.from(JSON.stringify(paymentEvent()), 'utf8');
    const body = Buffer.concat([json.subarray(0, -1), Buffer.from([0xff]), json.subarray(-1)]);
    expect((await call(request(body, signatureHeader(secret, now, body), true))).statusCode).toBe(400);
    expect(queue.messages).toHaveLength(0);
  });

  test('rejects a signed body that is missing fields with 400', async () => {
    const { queue, call } = setup();
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });
    expect((await call(request(body, signatureHeader(secret, now, body)))).statusCode).toBe(400);
    expect(queue.messages).toHaveLength(0);
  });

  test('rejects an oversized body with 413 before doing any crypto', async () => {
    const getSecrets = jest.fn(async () => [secret]);
    const handler = makeReceiver({ getSecrets, enqueue: async () => {}, nowSeconds: () => now });
    const res = (await handler(request('x'.repeat(MAX_BODY_BYTES + 1), 'h'))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(413);
    expect(getSecrets).not.toHaveBeenCalled();
  });

  test('lets a queue failure surface so the provider retries', async () => {
    const handler = makeReceiver({
      getSecrets: async () => [secret],
      enqueue: async () => { throw new Error('SQS down'); },
      nowSeconds: () => now,
    });
    const body = JSON.stringify(paymentEvent());
    await expect(handler(request(body, signatureHeader(secret, now, body)))).rejects.toThrow('SQS down');
  });
});

describe('cachedSecretLoader', () => {
  const sm = mockClient(SecretsManagerClient);
  beforeEach(() => sm.reset());

  test('reads current and previous, and caches for 5 minutes', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ current: 'a', previous: 'b' }) });
    let t = 0;
    const load = cachedSecretLoader(new SecretsManagerClient({}), 'arn', () => t);
    expect(await load()).toEqual(['a', 'b']);
    t = 4 * 60 * 1000;
    await load();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    t = 6 * 60 * 1000;
    await load();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  test('each loader has its own cache', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ current: 'a' }) });
    await cachedSecretLoader(new SecretsManagerClient({}), 'one')();
    await cachedSecretLoader(new SecretsManagerClient({}), 'two')();
    expect(sm.commandCalls(GetSecretValueCommand).map((c) => c.args[0].input.SecretId)).toEqual(['one', 'two']);
  });

  test('throws when "current" is missing, so a bad deploy is a 500 and an alarm, not a 401', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ current: '', previous: 'b' }) });
    await expect(cachedSecretLoader(new SecretsManagerClient({}), 'arn')()).rejects.toThrow('no "current" value');
  });

  test('does not cache a failure: the next request reads the secret again', async () => {
    sm.on(GetSecretValueCommand)
      .rejectsOnce(new Error('throttled'))
      .resolves({ SecretString: JSON.stringify({ current: 'a' }) });
    const load = cachedSecretLoader(new SecretsManagerClient({}), 'arn');
    await expect(load()).rejects.toThrow('throttled');
    expect(await load()).toEqual(['a']);
  });

  test('drops an empty previous secret', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ current: 'a', previous: '' }) });
    expect(await cachedSecretLoader(new SecretsManagerClient({}), 'arn')()).toEqual(['a']);
  });
});
