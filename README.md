# LogForge

LogForge is a resource-constrained log ingestion and query service built with Fastify, TypeScript, PostgreSQL, Drizzle ORM, RabbitMQ, Vitest, and k6.

## Resource limits

- Fastify application: `0.5 CPU`, `256 MB RAM`.
- RabbitMQ: `1 CPU`, `1 GB RAM`.
- PostgreSQL: `1 CPU`, `1 GB RAM`.
- HTTP port inside the container: `8080`.
- Host endpoint: `http://localhost:8080`.

## Run

```bash
docker compose up -d --build
```

Wait for readiness:

```bash
curl --fail http://localhost:8080/health
```

Stop every service:

```bash
docker compose down
```

Persistent PostgreSQL and RabbitMQ volumes are retained by the normal `down` command. Use `docker compose down -v` only when you intentionally want to erase all stored data and queued messages.

Change retention from its 30-day default at startup:

```bash
RETENTION_DAYS=14 docker compose up -d --build
```

## Architecture

`POST /logs` validates each entry independently and publishes valid batches to the durable `logs.ingest` RabbitMQ queue. A consumer coalesces queue messages and inserts up to 5,000 records with one parameterized SQL statement. PostgreSQL updates one-minute rollups from the inserted rows in that same statement. The HTTP response waits for the RabbitMQ publisher confirmation, but never waits for PostgreSQL.

Reads never pass through RabbitMQ. `GET /logs` uses PostgreSQL keyset pagination ordered by `(timestamp DESC, id DESC)`. Aggregation composes aligned ranges from one-minute rollups; searches, attribute filters, and partial-minute ranges use raw logs to preserve correctness.

The log query uses explicit `NULLS LAST` ordering to match the existing descending timestamp/ID indexes. Both pagination columns are non-null, so this preserves API ordering while allowing PostgreSQL to avoid unnecessary scans and sorts.

The startup order is:

1. PostgreSQL and RabbitMQ pass their container health checks.
2. The application connects to PostgreSQL and completes Drizzle migrations.
3. The application connects to RabbitMQ and declares its durable ingestion queue.
4. The consumer starts.
5. Fastify listens on port 8080 and `/health` begins returning `200`.

## Source layout

```text
src/
├── app.ts
├── server.ts
├── db/
├── modules/
│   ├── health/
│   ├── logs/
│   │   └── aggregate/
│   ├── queue/
│   └── retention/
└── shared/
```

Each HTTP module separates routes, controllers, services, repositories, validation, types, errors, and tests. The queue is isolated as its own module.

## API

### `GET /health`

Returns `200` only after migrations, PostgreSQL, RabbitMQ, the queue consumer, and the HTTP listener are ready.

### `POST /logs`

Accepts `{ "logs": [...] }`. Valid entries are queued and invalid entries return their original array index and reason. The endpoint returns `200` when at least one entry is accepted and `400` when none are accepted.

### `GET /logs`

Supports `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit`, and `cursor`. All parameters may be combined. Attribute values are compared using PostgreSQL text representation. The opaque cursor preserves deterministic `(timestamp, id)` ordering.

### `GET /logs/aggregate`

Requires `since`, `until`, and `bucket`. Supported buckets are `1m`, `5m`, `1h`, and `1d`; `group_by` may be `service` or `level`.

## Verification

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Run the full 30,000 logs/second benchmark after the service becomes healthy:

```bash
k6 run benchmark/load.js
```

Environment variables such as `TARGET_LPS`, `BATCH_SIZE`, `DURATION`, and `BASE_URL` can override benchmark defaults. The benchmark uses minute-aligned aggregation windows so its primary aggregation request exercises the one-minute rollup. It also verifies the exact accepted count and waits up to 20 seconds for those ingestion records to become visible in PostgreSQL.

Enable bounded queue and PostgreSQL write-pipeline telemetry during a diagnostic run:

```bash
LOG_LEVEL=info QUEUE_METRICS_INTERVAL_MS=10000 docker compose up -d --build
```

The telemetry reports validation cost; publish serialization and confirmation latency; confirmations in flight and publisher backpressure; publish, consume, and insert rates; ready and locally unacknowledged messages; batch preparation and insert duration; queue-to-database lag; failed inserts and requeues; plus process CPU, memory, and event-loop delay. It is disabled by default.

For a controlled publisher-only diagnostic, start the service with `QUEUE_CONSUMER_ENABLED=false`, then run k6 with `PUBLISHER_ONLY=true`. This keeps durable publishing and confirmations enabled while pausing database consumption, and removes read/persistence scenarios from that diagnostic load. The application option defaults to `true`, and the benchmark option defaults to `false`; neither diagnostic setting should be used for normal operation. Afterward, restart with the consumer enabled and allow its durable queue to drain before comparing persisted counts.

An HTTP client timeout does not imply that its batch was discarded. Once RabbitMQ publishing has started, the service cannot safely cancel the durable publish; the message may still be confirmed and persisted after the client disconnects. Clients that retry after an ambiguous timeout must account for the possibility of duplicates.

The k6 summary is written to `benchmark-summary.json`. It reports load-generator scheduling separately from persistence consistency: a run can fail its scheduled load target while still confirming that every accepted log was persisted.

To actually block merges, configure the repository's `main` branch protection to require both checks: `TypeScript and Vitest` and `30k logs/sec benchmark`.
