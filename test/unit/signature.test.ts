import { computeSignature, signatureHeader, verifySignature } from '../../lambda/shared/signature';

const secret = 'whsec_test_current';
const body = '{"id":"evt_1","type":"payment.succeeded"}';
const now = 1_760_000_000;

describe('verifySignature', () => {
  test('accepts a valid signature', () => {
    expect(verifySignature(signatureHeader(secret, now, body), body, [secret], now)).toEqual({ ok: true });
  });

  test('rejects a missing header', () => {
    expect(verifySignature(undefined, body, [secret], now)).toEqual({ ok: false, reason: 'missing' });
  });

  test.each(['', 'garbage', 't=abc,v1=00', `t=${now}`, `t=${now},v1=not-hex`])('rejects malformed header %p', (h) => {
    expect(verifySignature(h || 'x', body, [secret], now)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('rejects a request older than 5 minutes (replay)', () => {
    const header = signatureHeader(secret, now - 301, body);
    expect(verifySignature(header, body, [secret], now)).toEqual({ ok: false, reason: 'stale' });
  });

  test('accepts a request inside the 5 minute window', () => {
    expect(verifySignature(signatureHeader(secret, now - 299, body), body, [secret], now).ok).toBe(true);
  });

  test('rejects a body changed by one byte', () => {
    const header = signatureHeader(secret, now, body);
    expect(verifySignature(header, body.replace('evt_1', 'evt_2'), [secret], now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('rejects a reformatted body, because the HMAC covers raw bytes', () => {
    const header = signatureHeader(secret, now, body);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifySignature(header, pretty, [secret], now).ok).toBe(false);
  });

  test('rejects a fresh timestamp pasted onto an old signature', () => {
    const oldSig = computeSignature(secret, now - 3600, body);
    expect(verifySignature(`t=${now},v1=${oldSig}`, body, [secret], now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('rejects the wrong secret', () => {
    expect(verifySignature(signatureHeader('other', now, body), body, [secret], now).ok).toBe(false);
  });

  test('accepts the previous secret during rotation', () => {
    const header = signatureHeader('whsec_old', now, body);
    expect(verifySignature(header, body, [secret, 'whsec_old'], now).ok).toBe(true);
  });

  test('accepts a header with several v1 values when one matches', () => {
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${computeSignature(secret, now, body)}`;
    expect(verifySignature(header, body, [secret], now).ok).toBe(true);
  });

  test('never accepts when no secret is configured', () => {
    expect(verifySignature(signatureHeader('', now, body), body, [''], now).ok).toBe(false);
  });
});
