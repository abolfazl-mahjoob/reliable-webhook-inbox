import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

const SKEW_SECONDS = 300;
const HEX_SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const TENANT = /^[a-z0-9-]{1,64}$/;

export type SignedHeaders = Record<string, string | string[] | undefined>;

export interface SignedEvent {
  eventId: string;
  orderId: string;
  kind: 'order.paid';
}

function onlyHeader(headers: SignedHeaders, name: string): string {
  const value = headers[name];
  return typeof value === 'string' ? value : '';
}

export function parseSecrets(): Map<string, string> {
  const raw = process.env.WEBHOOK_SECRETS_JSON;
  if (!raw) throw new Error('WEBHOOK_SECRETS_JSON is required');
  const result: unknown = JSON.parse(raw);
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('WEBHOOK_SECRETS_JSON must be an object');
  }
  const map = new Map<string, string>();
  for (const [tenant, secret] of Object.entries(result)) {
    if (!TENANT.test(tenant) || typeof secret !== 'string' || secret.length < 32) {
      throw new Error('Invalid tenant ID or secret (minimum 32 characters)');
    }
    map.set(tenant, secret);
  }
  if (map.size === 0) throw new Error('At least one webhook tenant is required');
  return map;
}

export function authenticateWebhook(
  tenantId: string,
  headers: SignedHeaders,
  rawBody: Buffer | undefined,
  secret: string | undefined,
  now = Date.now(),
): { payload: SignedEvent; digest: string } {
  if (!TENANT.test(tenantId) || !secret || !rawBody || rawBody.length === 0) {
    throw new UnauthorizedException('Invalid webhook authentication');
  }
  if (rawBody.length > 256 * 1024) {
    throw new BadRequestException('Webhook body too large');
  }
  const timestamp = onlyHeader(headers, 'x-webhook-timestamp');
  const signature = onlyHeader(headers, 'x-webhook-signature');
  const eventId = onlyHeader(headers, 'x-webhook-event-id');
  if (!/^\d{10}$/.test(timestamp) || !ID.test(eventId)) {
    throw new UnauthorizedException('Invalid webhook headers');
  }
  const skew = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (skew > SKEW_SECONDS) throw new UnauthorizedException('Webhook timestamp expired');
  const match = HEX_SIGNATURE.exec(signature);
  if (!match) throw new UnauthorizedException('Invalid webhook signature');
  // Do not reserialize the request: only the actual received bytes are authenticated.
  const expected = createHmac('sha256', secret)
    .update(timestamp, 'utf8').update('.', 'utf8').update(rawBody).digest();
  const provided = Buffer.from(match[1], 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new UnauthorizedException('Invalid webhook signature');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(rawBody.toString('utf8')); }
  catch { throw new BadRequestException('Invalid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('Invalid event payload');
  }
  const event = parsed as Record<string, unknown>;
  if (event.eventId !== eventId || event.kind !== 'order.paid' ||
      typeof event.orderId !== 'string' || !ID.test(event.orderId)) {
    throw new BadRequestException('Invalid event contract');
  }
  return {
    payload: { eventId, kind: 'order.paid', orderId: event.orderId },
    digest: createHash('sha256').update(rawBody).digest('hex'),
  };
}
