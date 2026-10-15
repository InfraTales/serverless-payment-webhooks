/**
 * One row per provider event ID, written with a conditional put.
 *
 * claim()    -> 'claimed' when this worker may process the event,
 *               'done'    when an earlier delivery already finished it,
 *               'busy'    when another worker holds a lock that hasn't expired.
 * complete() -> marks it done and keeps the row until `expiresAt` (DynamoDB TTL).
 * release()  -> drops our lock after a failure so the next retry can claim it.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from './env';

export type ClaimResult = 'claimed' | 'done' | 'busy';

export interface IdempotencyStore {
  claim(eventId: string, nowSeconds: number): Promise<ClaimResult>;
  complete(eventId: string, nowSeconds: number): Promise<void>;
  release(eventId: string): Promise<void>;
}

export interface StoreOptions {
  tableName: string;
  /** Longer than the function timeout, shorter than the queue's visibility timeout. */
  lockSeconds: number;
  /** How long to remember a finished event. Must outlast the provider's retry window. */
  retentionSeconds: number;
}

export class DynamoIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly opts: StoreOptions,
  ) {}

  static fromEnv(client = new DynamoDBClient({})): DynamoIdempotencyStore {
    return new DynamoIdempotencyStore(DynamoDBDocumentClient.from(client), {
      tableName: requireEnv('EVENTS_TABLE'),
      lockSeconds: positiveInt('LOCK_SECONDS', 120),
      retentionSeconds: positiveInt('RETENTION_DAYS', 30) * 86400,
    });
  }

  async claim(eventId: string, nowSeconds: number): Promise<ClaimResult> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.opts.tableName,
          Item: {
            eventId,
            status: 'IN_PROGRESS',
            lockExpiresAt: nowSeconds + this.opts.lockSeconds,
            expiresAt: nowSeconds + this.opts.retentionSeconds,
          },
          // New event, or a lock left behind by a worker that timed out.
          ConditionExpression: 'attribute_not_exists(eventId) OR (#s = :inProgress AND lockExpiresAt < :now)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inProgress': 'IN_PROGRESS', ':now': nowSeconds },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'claimed';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return err.Item?.status?.S === 'COMPLETED' ? 'done' : 'busy';
      }
      throw err;
    }
  }

  async complete(eventId: string, nowSeconds: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.opts.tableName,
        Key: { eventId },
        UpdateExpression: 'SET #s = :completed, completedAt = :now, expiresAt = :exp REMOVE lockExpiresAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':completed': 'COMPLETED',
          ':now': nowSeconds,
          ':exp': nowSeconds + this.opts.retentionSeconds,
        },
      }),
    );
  }

  async release(eventId: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.opts.tableName,
          Key: { eventId },
          ConditionExpression: '#s = :inProgress',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inProgress': 'IN_PROGRESS' },
        }),
      );
    } catch (err) {
      // Someone else already finished it. Nothing to release.
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return n;
}
