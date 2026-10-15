import { DynamoIdempotencyStore } from '../../lambda/shared/idempotency';
import { requireEnv } from '../../lambda/shared/env';
import { statusRank } from '../../lambda/shared/event';

describe('requireEnv', () => {
  test('returns a set value', () => {
    expect(requireEnv('EVENTS_TABLE')).toBe('processed-events');
  });

  test('throws on a missing or empty value', () => {
    expect(() => requireEnv('NOT_SET_ANYWHERE')).toThrow('Missing required environment variable NOT_SET_ANYWHERE');
    process.env.EMPTY_FOR_TEST = '';
    expect(() => requireEnv('EMPTY_FOR_TEST')).toThrow('EMPTY_FOR_TEST');
  });
});

describe('DynamoIdempotencyStore.fromEnv', () => {
  afterEach(() => { delete process.env.LOCK_SECONDS; });

  test('rejects a lock time that is not a positive whole number', () => {
    process.env.LOCK_SECONDS = '2m';
    expect(() => DynamoIdempotencyStore.fromEnv()).toThrow('LOCK_SECONDS must be a positive whole number, got "2m"');
  });
});

describe('statusRank', () => {
  test('later lifecycle steps rank higher, unknown statuses rank lowest', () => {
    expect(statusRank('processing')).toBeLessThan(statusRank('succeeded'));
    expect(statusRank('succeeded')).toBe(statusRank('failed'));
    expect(statusRank('succeeded')).toBeLessThan(statusRank('refunded'));
    expect(statusRank('something_new')).toBe(0);
  });
});
