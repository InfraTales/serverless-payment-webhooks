/**
 * Runs against a real deployment. Acts as the payment provider:
 *   1. a forged request must get 401,
 *   2. one signed event sent three times must produce one COMPLETED row,
 *   3. an older event sent after a newer one must not change the payment.
 *
 * Usage: npm run smoke            (reads outputs from the PaymentWebhooks stack)
 * Needs AWS credentials for the account the stack is in.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { signatureHeader } from '../lambda/shared/signature';

const STACK = process.env.STACK_NAME ?? 'PaymentWebhooks';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function outputs(): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
  return Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

async function post(url: string, body: string, header: string): Promise<number> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': header }, body });
  return res.status;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function check(ok: boolean, message: string) {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function main() {
  const out = await outputs();
  const secretRes = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: out.SigningSecretArn }));
  const secret = (JSON.parse(secretRes.SecretString!) as { current: string }).current;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const run = Date.now().toString(36);

  const event = (id: string, created: number, status: string, paymentId = `pay_smoke_${run}`) =>
    JSON.stringify({ id, type: `payment.${status}`, created, data: { paymentId, amount: 1250, currency: 'usd', status } });
  const completed = (eventId: string) => async () => {
    const r = await doc.send(new GetCommand({ TableName: out.EventsTableName, Key: { eventId } }));
    return r.Item?.status === 'COMPLETED' ? true : undefined;
  };

  // 1. forged
  const forged = event(`evt_forged_${run}`, now(), 'succeeded');
  check((await post(out.WebhookUrl, forged, signatureHeader('wrong-secret', now(), forged))) === 401, 'forged signature gets 401');

  // 2. duplicates
  const id = `evt_smoke_${run}`;
  const body = event(id, now(), 'succeeded');
  for (let i = 0; i < 3; i++) {
    check((await post(out.WebhookUrl, body, signatureHeader(secret, now(), body))) === 200, `delivery ${i + 1} of the same event gets 200`);
  }
  const row = await waitFor('the event to complete', async () => {
    const r = await doc.send(new GetCommand({ TableName: out.EventsTableName, Key: { eventId: id } }));
    return r.Item?.status === 'COMPLETED' ? r.Item : undefined;
  });
  check(row.status === 'COMPLETED', 'three deliveries left one COMPLETED idempotency row');

  // 3. out of order: an older "processing" event arrives late
  const late = event(`evt_late_${run}`, now() - 600, 'processing');
  check((await post(out.WebhookUrl, late, signatureHeader(secret, now(), late))) === 200, 'late older event gets 200');
  await waitFor('the late event to complete', completed(`evt_late_${run}`));
  const payment = await doc.send(new GetCommand({ TableName: out.PaymentsTableName, Key: { paymentId: `pay_smoke_${run}` } }));
  check(payment.Item?.status === 'succeeded' && payment.Item?.lastEventId === id, 'late older event did not overwrite the newer state');

  // 4. same second, in order: "processing", then "succeeded" with the same timestamp. The later step must win.
  const tiePayment = `pay_tie_${run}`;
  const t = now();
  for (const [eventId, status] of [[`evt_tie_a_${run}`, 'processing'], [`evt_tie_b_${run}`, 'succeeded']]) {
    const b = event(eventId, t, status, tiePayment);
    check((await post(out.WebhookUrl, b, signatureHeader(secret, now(), b))) === 200, `same-second ${status} gets 200`);
    await waitFor(`${eventId} to complete`, completed(eventId));
  }
  const tie = await doc.send(new GetCommand({ TableName: out.PaymentsTableName, Key: { paymentId: tiePayment } }));
  check(tie.Item?.status === 'succeeded', 'same-second "succeeded" replaced "processing"');

  console.log('\nsmoke test passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
