import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoIdempotencyStore } from '../../lambda/shared/idempotency';

const ddb = mockClient(DynamoDBDocumentClient);
const store = new DynamoIdempotencyStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
  tableName: 'processed-events',
  lockSeconds: 120,
  retentionSeconds: 30 * 86400,
});
const now = 1_760_000_000;

const conditionFailed = (item?: Record<string, any>) =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {}, Item: item });

beforeEach(() => ddb.reset());

describe('DynamoIdempotencyStore.claim', () => {
  test('writes an IN_PROGRESS row with a lock and a TTL', async () => {
    ddb.on(PutCommand).resolves({});
    expect(await store.claim('evt_1', now)).toBe('claimed');

    const input = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item).toEqual({ eventId: 'evt_1', status: 'IN_PROGRESS', lockExpiresAt: now + 120, expiresAt: now + 30 * 86400 });
    expect(input.ConditionExpression).toBe('attribute_not_exists(eventId) OR (#s = :inProgress AND lockExpiresAt < :now)');
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  test("returns 'done' when the row is COMPLETED", async () => {
    ddb.on(PutCommand).rejects(conditionFailed({ status: { S: 'COMPLETED' } }));
    expect(await store.claim('evt_1', now)).toBe('done');
  });

  test("returns 'busy' when another worker holds a live lock", async () => {
    ddb.on(PutCommand).rejects(conditionFailed({ status: { S: 'IN_PROGRESS' }, lockExpiresAt: { N: String(now + 60) } }));
    expect(await store.claim('evt_1', now)).toBe('busy');
  });

  test('rethrows other DynamoDB errors', async () => {
    ddb.on(PutCommand).rejects(new Error('ProvisionedThroughputExceeded'));
    await expect(store.claim('evt_1', now)).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});

describe('DynamoIdempotencyStore.complete and release', () => {
  test('complete sets COMPLETED, removes the lock and refreshes the TTL', async () => {
    ddb.on(UpdateCommand).resolves({});
    await store.complete('evt_1', now);
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE lockExpiresAt');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':completed': 'COMPLETED', ':exp': now + 30 * 86400 });
  });

  test('release deletes only an IN_PROGRESS row', async () => {
    ddb.on(DeleteCommand).resolves({});
    await store.release('evt_1');
    expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.ConditionExpression).toBe('#s = :inProgress');
  });

  test('release ignores a row that is already COMPLETED', async () => {
    ddb.on(DeleteCommand).rejects(conditionFailed());
    await expect(store.release('evt_1')).resolves.toBeUndefined();
  });
});
