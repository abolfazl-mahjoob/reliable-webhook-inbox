import { createHmac } from 'node:crypto';
import {
  BadRequestException, UnauthorizedException,
} from '@nestjs/common';
import {
  authenticateWebhook, parseSecrets,
} from '../../src/security/webhook-signature';

const tenant = 'demo';
const secret = 'long-enough-unit-testing-secret-0123456789';
const time = 1_800_000_000_000;
const ts = String(Math.floor(time / 1000));
const body = Buffer.from(JSON.stringify({
  eventId: 'evt-1', orderId: 'order-1', kind: 'order.paid',
}));

function headers(raw: Buffer = body, timestamp = ts): Record<string, string> {
  return {
    'x-webhook-timestamp': timestamp,
    'x-webhook-event-id': 'evt-1',
    'x-webhook-signature': 'sha256=' + createHmac('sha256', secret)
      .update(timestamp).update('.').update(raw).digest('hex'),
  };
}

describe('raw-body HMAC verification', () => {
  test('accepts only the signed raw bytes', () => {
    const result = authenticateWebhook(tenant, headers(), body, secret, time);
    expect(result.payload).toEqual({
      eventId: 'evt-1', orderId: 'order-1', kind: 'order.paid',
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not authenticate reserialized or reordered JSON', () => {
    const altered = Buffer.from('{"orderId":"order-1","eventId":"evt-1","kind":"order.paid"}');
    expect(() => authenticateWebhook(tenant, headers(), altered, secret, time))
      .toThrow(UnauthorizedException);
  });

  test('rejects tampered signature, missing secret and malformed signature', () => {
    expect(() => authenticateWebhook(tenant, {
      ...headers(), 'x-webhook-signature': 'sha256=' + 'a'.repeat(64),
    }, body, secret, time)).toThrow(UnauthorizedException);
    expect(() => authenticateWebhook(tenant, headers(), body, undefined, time))
      .toThrow(UnauthorizedException);
    expect(() => authenticateWebhook(tenant, {
      ...headers(), 'x-webhook-signature': 'zz',
    }, body, secret, time)).toThrow(UnauthorizedException);
  });

  test.each([-301, 301])('rejects %i second timestamp drift', (delta) => {
    const outside = String(Number(ts) + delta);
    expect(() => authenticateWebhook(tenant, headers(body, outside), body, secret, time))
      .toThrow(UnauthorizedException);
  });

  test('rejects repeated header values and invalid event identifiers', () => {
    expect(() => authenticateWebhook(tenant, {
      ...headers(), 'x-webhook-timestamp': [ts, ts],
    }, body, secret, time)).toThrow(UnauthorizedException);
    expect(() => authenticateWebhook(tenant, {
      ...headers(), 'x-webhook-event-id': '../bad',
    }, body, secret, time)).toThrow(UnauthorizedException);
  });

  test('rejects correctly signed malformed JSON', () => {
    const invalid = Buffer.from('{oops');
    expect(() => authenticateWebhook(tenant, headers(invalid), invalid, secret, time))
      .toThrow(BadRequestException);
  });

  test('rejects mismatching header/payload event ID and unsupported kind', () => {
    const wrongId = Buffer.from(JSON.stringify({
      eventId: 'other', orderId: 'order-1', kind: 'order.paid',
    }));
    expect(() => authenticateWebhook(tenant, headers(wrongId), wrongId, secret, time))
      .toThrow(BadRequestException);
    const wrongKind = Buffer.from(JSON.stringify({
      eventId: 'evt-1', orderId: 'order-1', kind: 'order.cancelled',
    }));
    expect(() => authenticateWebhook(tenant, headers(wrongKind), wrongKind, secret, time))
      .toThrow(BadRequestException);
  });

  test('rejects requests larger than the bounded body size', () => {
    expect(() => authenticateWebhook(tenant, headers(), Buffer.alloc(256 * 1024 + 1), secret, time))
      .toThrow(BadRequestException);
  });

  test('tenant secrets must be structurally valid', () => {
    const previous = process.env.WEBHOOK_SECRETS_JSON;
    try {
      process.env.WEBHOOK_SECRETS_JSON = JSON.stringify({ demo: secret });
      expect(parseSecrets().get('demo')).toBe(secret);
      process.env.WEBHOOK_SECRETS_JSON = JSON.stringify({ demo: 'short' });
      expect(() => parseSecrets()).toThrow('Invalid tenant ID');
    } finally {
      if (previous === undefined) delete process.env.WEBHOOK_SECRETS_JSON;
      else process.env.WEBHOOK_SECRETS_JSON = previous;
    }
  });
});
