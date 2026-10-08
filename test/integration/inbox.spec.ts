import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { InboxService } from '../../src/inbox.service';

const tenant = 'demo';
const secret = 'integration-example-secret-not-for-production-12345';
const dbUrl = process.env.DATABASE_URL;

function signed(id: string, orderId = id, tenantId = tenant) {
  const payload = { eventId: id, orderId, kind: 'order.paid' };
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'x-webhook-event-id': id,
      'x-webhook-timestamp': ts,
      'x-webhook-signature': 'sha256=' + createHmac('sha256', secret)
        .update(ts).update('.').update(Buffer.from(body)).digest('hex'),
    },
    tenantId,
  };
}

describe('real PostgreSQL inbox / NestJS HTTP contracts', () => {
  let app: NestExpressApplication;
  let db: Pool;
  let inbox: InboxService;
  const originalSecrets = process.env.WEBHOOK_SECRETS_JSON;
  const originalDisable = process.env.DISABLE_SCHEDULED_WORKER;

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL required for integration suite');
    process.env.WEBHOOK_SECRETS_JSON = JSON.stringify({ demo: secret });
    process.env.DISABLE_SCHEDULED_WORKER = 'true';
    db = new Pool({ connectionString: dbUrl });
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      rawBody: true, bodyParser: false, logger: false,
    });
    app.useBodyParser('json', { limit: '256kb' });
    await app.init();
    inbox = app.get(InboxService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.end();
    if (originalSecrets === undefined) delete process.env.WEBHOOK_SECRETS_JSON;
    else process.env.WEBHOOK_SECRETS_JSON = originalSecrets;
    if (originalDisable === undefined) delete process.env.DISABLE_SCHEDULED_WORKER;
    else process.env.DISABLE_SCHEDULED_WORKER = originalDisable;
  });

  beforeEach(async () => {
    await db.query('TRUNCATE TABLE processed_orders, inbox_events');
  });

  async function post(id: string, orderId?: string, forTenant = tenant) {
    const data = signed(id, orderId, forTenant);
    return request(app.getHttpServer())
      .post('/webhooks/' + forTenant)
      .set('Content-Type', 'application/json')
      .set(data.headers)
      .send(data.body);
  }

  test('health and durable 202 then local transactional effect', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
    const accepted = await post('evt-001', 'order-001');
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ accepted: true, duplicate: false, status: 'pending' });
    let effects = await db.query('SELECT * FROM processed_orders');
    expect(effects.rowCount).toBe(0); // ACK before delivery, never best-effort only.
    await inbox.drain();
    effects = await db.query('SELECT * FROM processed_orders');
    expect(effects.rows).toMatchObject([{
      tenant_id: tenant, order_id: 'order-001', first_event_id: 'evt-001',
    }]);
    const states = await db.query("SELECT status,attempts FROM inbox_events");
    expect(states.rows).toMatchObject([{ status: 'completed', attempts: 1 }]);
  });

  test('same event ID and raw bytes are idempotent across 20 concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => post('evt-dup')));
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(responses.filter((r) => !r.body.duplicate)).toHaveLength(1);
    const saved = await db.query('SELECT id FROM inbox_events');
    expect(saved.rowCount).toBe(1);
    await inbox.drain();
    await inbox.drain();
    expect((await db.query('SELECT * FROM processed_orders')).rowCount).toBe(1);
    const replay = await post('evt-dup');
    expect(replay.body).toMatchObject({ duplicate: true, status: 'completed' });
    expect((await db.query('SELECT attempts FROM inbox_events')).rows[0].attempts).toBe(1);
  });

  test('reusing event ID with different signed bytes is a 409 conflict', async () => {
    expect((await post('evt-change', 'order-a')).status).toBe(202);
    expect((await post('evt-change', 'order-b')).status).toBe(409);
    expect((await db.query('SELECT count(*)::int AS n FROM inbox_events')).rows[0].n).toBe(1);
  });

  test('tenant spoofing, expired signatures and forged HMAC are rejected', async () => {
    expect((await post('evt-foreign', undefined, 'unknown')).status).toBe(401);
    const data = signed('evt-bad');
    const forged = await request(app.getHttpServer()).post('/webhooks/demo')
      .set('Content-Type', 'application/json')
      .set({ ...data.headers, 'x-webhook-signature': 'sha256=' + '0'.repeat(64) })
      .send(data.body);
    expect(forged.status).toBe(401);
    const oldTs = String(Math.floor(Date.now() / 1000) - 301);
    const expired = await request(app.getHttpServer()).post('/webhooks/demo')
      .set('Content-Type', 'application/json')
      .set({
        'x-webhook-event-id': data.headers['x-webhook-event-id'],
        'x-webhook-timestamp': oldTs,
        'x-webhook-signature': 'sha256=' + createHmac('sha256', secret)
          .update(oldTs).update('.').update(Buffer.from(data.body)).digest('hex'),
      }).send(data.body);
    expect(expired.status).toBe(401);
    expect((await db.query('SELECT * FROM inbox_events')).rowCount).toBe(0);
  });

  test('worker instances safely divide work via SKIP LOCKED claims', async () => {
    for (let i = 0; i < 40; i++) {
      const received = await post('evt-' + i, 'order-' + i);
      expect(received.status).toBe(202);
    }
    await Promise.all(Array.from({ length: 8 }, () => inbox.drain(8)));
    const summary = await db.query(
      "SELECT status, count(*)::integer AS count FROM inbox_events GROUP BY status",
    );
    expect(summary.rows).toEqual([{ status: 'completed', count: 40 }]);
    expect((await db.query('SELECT * FROM processed_orders')).rowCount).toBe(40);
    expect((await db.query('SELECT MAX(attempts) as attempts FROM inbox_events')).rows[0].attempts)
      .toBe(1);
  });

  test('stale lease is reclaimed safely and terminal stale lease is dead-lettered', async () => {
    await post('evt-stale');
    await db.query(
      `UPDATE inbox_events SET status='processing',attempts=2,
       lock_token=gen_random_uuid(),locked_until=now()-INTERVAL '10 seconds'`,
    );
    await inbox.drain();
    const row = await db.query('SELECT status,attempts FROM inbox_events');
    expect(row.rows).toMatchObject([{ status: 'completed', attempts: 3 }]);
    await post('evt-dead');
    await db.query(
      `UPDATE inbox_events SET status='processing',attempts=5,
       lock_token=gen_random_uuid(),locked_until=now()-INTERVAL '10 seconds'
       WHERE event_id='evt-dead'`,
    );
    await inbox.drain();
    const terminal = await db.query(
      "SELECT status,attempts FROM inbox_events WHERE event_id='evt-dead'",
    );
    expect(terminal.rows).toMatchObject([{ status: 'dead', attempts: 5 }]);
    const duplicate = await post('evt-dead');
    expect(duplicate.body).toMatchObject({ duplicate: true, status: 'dead' });
  });

  test('multiple event IDs for the same order produce one idempotent domain effect', async () => {
    await post('evt-a', 'shared-order');
    await post('evt-b', 'shared-order');
    await inbox.drain();
    const effect = await db.query('SELECT * FROM processed_orders');
    expect(effect.rowCount).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM inbox_events WHERE status='completed'"))
      .rows[0].n).toBe(2);
  });
});
