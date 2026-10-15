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
import { requireEnv } from './shared/env';

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
    const bytes = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64') : Buffer.from(event.body ?? '', 'utf8');
    if (bytes.length > MAX_BODY_BYTES) return reply(413, { error: 'payload too large' });

    // HTTP APIs pass header names in lower case.
    const result = verifySignature(event.headers?.['x-webhook-signature'], bytes, await deps.getSecrets(), deps.nowSeconds());
    if (!result.ok) {
      console.warn(JSON.stringify({ msg: 'signature rejected', reason: result.reason, requestId: event.requestContext?.requestId }));
      return reply(401, { error: 'invalid signature' });
    }

    // JSON is UTF-8 (RFC 8259). Decoding strictly means the text we queue is exactly what was signed.
    const raw = decodeUtf8(bytes);
    const parsed = raw === undefined ? undefined : parsePaymentEvent(raw);
    if (raw === undefined || !parsed) return reply(400, { error: 'invalid event' });

    // If this throws, the provider gets a 500 and retries later. That is what we want.
    await deps.enqueue(parsed.id, raw);
    console.log(JSON.stringify({ msg: 'queued', eventId: parsed.id, type: parsed.type }));
    return reply(200, { received: true });
  };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

// ---------- wiring for the real Lambda ----------

const SECRET_CACHE_MS = 5 * 60 * 1000;

/**
 * Loads {"current", "previous"} and keeps it for 5 minutes per container.
 * A secret with no "current" value is a deploy mistake, not a bad request, so it
 * throws: the provider gets a 500 and retries, and the 5xx alarm fires.
 */
export function cachedSecretLoader(client: SecretsManagerClient, secretId: string, now = () => Date.now()) {
  let cached: { secrets: string[]; at: number } | undefined;
  return async (): Promise<string[]> => {
    if (cached && now() - cached.at < SECRET_CACHE_MS) return cached.secrets;
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = JSON.parse(res.SecretString ?? '{}') as { current?: unknown; previous?: unknown };
    if (typeof value.current !== 'string' || value.current.length === 0) {
      throw new Error('Signing secret has no "current" value');
    }
    const secrets = [value.current, value.previous].filter((s): s is string => typeof s === 'string' && s.length > 0);
    cached = { secrets, at: now() };
    return secrets;
  };
}

const sqs = new SQSClient({});
const queueUrl = requireEnv('QUEUE_URL');

export const handler = makeReceiver({
  getSecrets: cachedSecretLoader(new SecretsManagerClient({}), requireEnv('SIGNING_SECRET_ARN')),
  enqueue: async (eventId, rawBody) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: rawBody,
        MessageAttributes: { eventId: { DataType: 'String', StringValue: eventId } },
      }),
    );
  },
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
