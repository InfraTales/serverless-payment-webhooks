/**
 * Webhook receiver. It does three things and nothing else:
 *   1. checks the HMAC signature against the raw body,
 *   2. checks the body has the fields the processor needs,
 *   3. puts the verified body on the queue and answers 200.
 *
 * All real work happens in the processor, so the provider gets a fast answer
 * and a slow database never turns into provider-side retries.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { verifySignature } from './shared/signature';
import { parsePaymentEvent } from './shared/event';

export const MAX_BODY_BYTES = 64 * 1024;

export interface ReceiverDeps {
  getSecrets: () => Promise<string[]>;
  enqueue: (eventId: string, rawBody: string) => Promise<void>;
  nowSeconds: () => number;
}

const reply = (statusCode: number, body: object): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function makeReceiver(deps: ReceiverDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    // HMAC is computed over the exact bytes the provider sent, so never re-serialize the JSON.
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return reply(413, { error: 'payload too large' });

    // HTTP APIs pass header names in lower case.
    const result = verifySignature(event.headers?.['x-webhook-signature'], raw, await deps.getSecrets(), deps.nowSeconds());
    if (!result.ok) {
      console.warn(JSON.stringify({ msg: 'signature rejected', reason: result.reason, requestId: event.requestContext?.requestId }));
      return reply(401, { error: 'invalid signature' });
    }

    const parsed = parsePaymentEvent(raw);
    if (!parsed) return reply(400, { error: 'invalid event' });

    // If this throws, the provider gets a 500 and retries later. That is what we want.
    await deps.enqueue(parsed.id, raw);
    console.log(JSON.stringify({ msg: 'queued', eventId: parsed.id, type: parsed.type }));
    return reply(200, { received: true });
  };
}

// ---------- wiring for the real Lambda ----------

const SECRET_CACHE_MS = 5 * 60 * 1000;
let cached: { secrets: string[]; at: number } | undefined;

export function cachedSecretLoader(client: SecretsManagerClient, secretId: string, now = () => Date.now()) {
  return async (): Promise<string[]> => {
    if (cached && now() - cached.at < SECRET_CACHE_MS) return cached.secrets;
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = JSON.parse(res.SecretString ?? '{}');
    cached = { secrets: [value.current, value.previous].filter((s): s is string => typeof s === 'string' && s.length > 0), at: now() };
    return cached.secrets;
  };
}

export function resetSecretCache(): void {
  cached = undefined;
}

const sqs = new SQSClient({});

export const handler = makeReceiver({
  getSecrets: cachedSecretLoader(new SecretsManagerClient({}), process.env.SIGNING_SECRET_ARN!),
  enqueue: async (eventId, rawBody) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL!,
        MessageBody: rawBody,
        MessageAttributes: { eventId: { DataType: 'String', StringValue: eventId } },
      }),
    );
  },
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
