# Reliable Webhook Inbox

**Authenticated webhook ingestion and durable at-least-once processing with NestJS, TypeScript and PostgreSQL.**

A standalone educational and engineering reference extracted and adapted
from the real commerce-webhook challenges encountered in **Amoozyar**.

[![Quality gate](https://github.com/abolfazl-mahjoob/reliable-webhook-inbox/actions/workflows/ci.yml/badge.svg)](https://github.com/abolfazl-mahjoob/reliable-webhook-inbox/actions/workflows/ci.yml)

## Why this exists

External senders retry webhook requests, the same event can arrive 20
times concurrently, and a server may crash immediately after replying
`202 Accepted`. The code illustrates how to preserve events and process
them without assuming networks, processes or delivery are reliable.

## HTTP contract

`POST /webhooks/:tenantId` accepts an `order.paid` JSON event with
`eventId` and `orderId`, HMAC-signed using a timestamp and event ID
header. A durable event returns HTTP `202`; replay with identical bytes
returns `202` and `duplicate: true`, while reusing the same event ID
for a different payload returns `409`. Health check: `GET /health`.

## Features

- HMAC-SHA256 verified against **exact raw request bytes** (not reserialized JSON)
- Per-tenant secrets, timestamp skew checks and constant-time signature comparison
- Postgres-backed inbox with unique `(tenant_id,event_id)` idempotency
- Atomic claims via `FOR UPDATE SKIP LOCKED`, time-limited leases and fencing token
- Recovery from crashed/stalled worker claims, retries and dead-letter state
- Domain effect and completion committed in **one SQL transaction**
- Integration tests with actual PostgreSQL and concurrent NestJS HTTP requests
- CI on Node.js 22/24 with build, tests, security audit and Docker smoke check

## Start locally

Requires **Node.js 22+** and Docker for PostgreSQL.

```bash
docker compose up -d postgres
cp .env.example .env
# Replace the demonstration secret before any remotely reachable deployment.
npm install
node --env-file=.env scripts/migrate.cjs
npm run build
node --env-file=.env dist/main.js
```

In another terminal, with `DEMO_SECRET` set to the same key for tenant
`demo`, run:

```bash
node --env-file=.env examples/send-demo.cjs
```

The request returns `202` only after its event is durably recorded.
The scheduled worker claims and acknowledges it separately.

## Run tests

```bash
npm install
# DATABASE_URL must point at an isolated, disposable test database.
npm run migrate
npm test -- --coverage
npm run typecheck
```

Tests intentionally use a **disposable test database** because they truncate
`inbox_events` and `processed_orders`.

For accurate guarantees, restrictions and trade-offs see
[Architecture and operational considerations](docs/architecture.md).

## What this does NOT promise

This is not an exactly-once third-party delivery system. The sample
`processed_orders` write is an **idempotent local transaction**;
external network side effects must be independently idempotent or placed
behind a transactional outbox. It is a reference project, not a drop-in
production payment handler.

## Origin & scope

Design adapted from the private Amoozyar NestJS commerce webhook workflow,
rewritten as a generic domain-free example. No original product source,
configuration, private keys, customer data or private repository history
is included. MIT license applies to this standalone code, subject to
source ownership and publication rights.
