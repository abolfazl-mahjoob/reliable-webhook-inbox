import {
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DB } from './database';
import { authenticateWebhook, parseSecrets, SignedHeaders } from './security/webhook-signature';

export type EventStatus = 'pending' | 'processing' | 'completed' | 'dead';
export interface InboxReceipt {
  accepted: true;
  duplicate: boolean;
  status: EventStatus;
}
interface Claim {
  id: string;
  lock_token: string;
}
interface LockedEvent {
  tenant_id: string;
  event_id: string;
  payload: { eventId: string; orderId: string; kind: 'order.paid' };
  status: EventStatus;
  lock_token: string | null;
  locked_until: Date | null;
}

const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 45;

@Injectable()
export class InboxService {
  private readonly secrets = parseSecrets();

  constructor(@Inject(DB) private readonly db: Pool) {}

  async receive(tenantId: string, headers: SignedHeaders, rawBody?: Buffer): Promise<InboxReceipt> {
    const { payload, digest } = authenticateWebhook(
      tenantId, headers, rawBody, this.secrets.get(tenantId),
    );
    const result = await this.db.query<{ status: EventStatus }>(
      `INSERT INTO inbox_events (tenant_id, event_id, content_sha256, payload)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (tenant_id,event_id) DO NOTHING
       RETURNING status`,
      [tenantId, payload.eventId, digest, JSON.stringify(payload)],
    );
    if (result.rowCount === 1) {
      return { accepted: true, duplicate: false, status: 'pending' };
    }
    const old = await this.db.query<{ content_sha256: string; status: EventStatus }>(
      'SELECT content_sha256, status FROM inbox_events WHERE tenant_id=$1 AND event_id=$2',
      [tenantId, payload.eventId],
    );
    if (old.rowCount !== 1) throw new Error('Conflicting inbox entry disappeared');
    if (old.rows[0].content_sha256 !== digest) {
      throw new ConflictException('Event ID reused with a different payload');
    }
    // Replays never reset retries or dead-letter state.
    return { accepted: true, duplicate: true, status: old.rows[0].status };
  }

  async drain(limit = 20): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be 1..100');
    }
    // Exhausted expired leases become dead-lettered, never reclaimed forever.
    await this.db.query(
      `UPDATE inbox_events SET status='dead', lock_token=NULL, locked_until=NULL,
         updated_at=now(), last_error='Processing lease expired after max attempts'
       WHERE status='processing' AND locked_until<=now() AND attempts >= $1`,
      [MAX_ATTEMPTS],
    );
    const claims = await this.db.query<Claim>(
      `WITH due AS (
         SELECT id FROM inbox_events
          WHERE attempts < $1
            AND ((status='pending' AND available_at<=now())
              OR (status='processing' AND locked_until<=now()))
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE inbox_events e SET
         status='processing', attempts=e.attempts+1,
         lock_token=gen_random_uuid(),
         locked_until=now()+($3::integer * INTERVAL '1 second'),
         updated_at=now()
       FROM due WHERE e.id=due.id
       RETURNING e.id, e.lock_token`,
      [MAX_ATTEMPTS, limit, LEASE_SECONDS],
    );
    // Claims are already durable. Failures inside processing leave a retryable
    // pending row or an expiring lease for another worker to recover.
    await Promise.allSettled(claims.rows.map(async (claim) => {
      try { await this.processClaim(claim); }
      catch (error) { await this.failClaim(claim, error); }
    }));
    return claims.rowCount ?? 0;
  }

  private async processClaim(claim: Claim): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<LockedEvent>(
        `SELECT tenant_id,event_id,payload,status,lock_token,locked_until
         FROM inbox_events WHERE id=$1 FOR UPDATE`,
        [claim.id],
      );
      const event = result.rows[0];
      // Fencing: slow workers cannot complete a lease reclaimed by another
      // process, and cannot commit after lease expiry.
      if (!event || event.status !== 'processing' ||
          event.lock_token !== claim.lock_token ||
          !event.locked_until || event.locked_until.getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return;
      }
      if (event.payload.kind !== 'order.paid') throw new Error('Unexpected event kind');
      await this.applyLocalEffect(client, event);
      const done = await client.query(
        `UPDATE inbox_events SET status='completed', locked_until=NULL,
          lock_token=NULL, completed_at=now(), updated_at=now(), last_error=NULL
          WHERE id=$1 AND lock_token=$2 AND locked_until>now()`,
        [claim.id, claim.lock_token],
      );
      if (done.rowCount !== 1) throw new Error('Lease expired during transaction');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyLocalEffect(client: PoolClient, event: LockedEvent): Promise<void> {
    // Idempotent domain update in the *same* transaction as marking processed.
    // It is NOT a claim of exactly-once external HTTP, email or payment delivery.
    await client.query(
      `INSERT INTO processed_orders (tenant_id,order_id,first_event_id)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id,order_id) DO NOTHING`,
      [event.tenant_id, event.payload.orderId, event.event_id],
    );
  }

  private async failClaim(claim: Claim, reason: unknown): Promise<void> {
    // Error details are deliberately not persisted: they may contain PII/secrets.
    // Jitter reduces synchronized retry bursts. Cap exponential growth.
    const errorCode = reason instanceof Error ? reason.name : 'UnknownError';
    const jitterMs = Math.floor(Math.random() * 500);
    await this.db.query(
      `UPDATE inbox_events SET
        status=CASE WHEN attempts >= $3 THEN 'dead' ELSE 'pending' END,
        available_at=now()+((LEAST(300000, (1000 * power(2, LEAST(attempts - 1, 8)))::integer) + $4::integer) * INTERVAL '1 millisecond'),
        locked_until=NULL, lock_token=NULL, updated_at=now(),
        last_error=$5
       WHERE id=$1 AND lock_token=$2 AND status='processing' AND locked_until>now()`,
      [claim.id, claim.lock_token, MAX_ATTEMPTS, jitterMs, errorCode],
    );
  }
}
