CREATE TABLE IF NOT EXISTS inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 64),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  content_sha256 char(64) NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lock_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, event_id),
  CONSTRAINT lease_state CHECK (
    (status = 'processing' AND lock_token IS NOT NULL AND locked_until IS NOT NULL)
    OR (status <> 'processing' AND lock_token IS NULL AND locked_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS inbox_pending_idx
  ON inbox_events (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS inbox_lease_idx
  ON inbox_events (locked_until)
  WHERE status = 'processing';

-- A deliberately local transactional side effect; transactionally coupled to
-- acknowledging the inbox event. External network calls require THEIR OWN
-- idempotency contract and cannot inherit this exactly-once guarantee.
CREATE TABLE IF NOT EXISTS processed_orders (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  first_event_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
