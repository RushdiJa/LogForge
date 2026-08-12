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

`POST /logs` validates each entry independently and publishes valid batches to the durable `logs.ingest` RabbitMQ queue. A consumer coalesces queue messages and transactionally streams up to 5,000 records into PostgreSQL with `COPY FROM STDIN`, then applies application-preaggregated one-minute rollup deltas before commit. Every included RabbitMQ message is acknowledged only after that shared transaction commits. The HTTP response waits for the RabbitMQ publisher confirmation, but never waits for PostgreSQL.

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

The telemetry reports validation cost; publish serialization and confirmation latency; confirmations in flight and publisher backpressure; publish, consume, and insert rates; ready and locally unacknowledged messages; batch assembly wait and payload size; raw COPY, rollup aggregation, rollup upsert, transaction, and acknowledgement timing; queue-to-database lag; active writers; failed inserts and requeues; plus process CPU, memory, and event-loop delay. It is disabled by default.

`QUEUE_MAX_BATCH_LOGS` defaults to 5,000 and `QUEUE_WRITE_CONCURRENCY` defaults to one. Measurements on the constrained one-CPU PostgreSQL service showed that 2,000- and 10,000-log transactions were slower, while two concurrent writers saturated PostgreSQL without improving sustained throughput. The concurrency option is bounded to one or two for controlled diagnostics.

PostgreSQL permits up to 4 GB of WAL between size-driven checkpoints. This setting does not allocate shared memory or weaken `fsync`, `synchronous_commit`, or full-page writes; it avoids forced checkpoints during the 2.4-million-row benchmark and uses disk space only. The other PostgreSQL memory and container limits remain unchanged.

The `logs` table starts insert-triggered autovacuum after five million new rows. Dead-row vacuuming and autoanalyze retain their defaults. This prevents a full append-only table scan from competing with the two-minute benchmark while retaining regular cleanup for retention deletes and periodic visibility-map/freeze maintenance during sustained operation.

The migration path preserves pre-partition data as an attached `logs_legacy` ID-range partition and routes later sequence IDs to a fresh `logs_hot` partition. `logs` remains the partitioned PostgreSQL source of truth, so COPY, reads, cursor ordering, raw aggregation, and retention continue to use the same logical table while current writes avoid amplifying the mature legacy indexes. The hot partition retains the same primary, timestamp, service/level, and trigram indexes and the five-million-row insert-vacuum threshold.

Level-only queries use the descending timestamp/ID index and apply the four-value enum as a filter. The separate level/timestamp/ID index was removed after it reached 653 MB with one recorded scan across roughly ten million rows; the replacement plan returned 101 representative rows in 0.978 ms. Restore it, if a future workload demonstrates a need, with `CREATE INDEX CONCURRENTLY "logs_level_timestamp_id_idx" ON "logs" ("level", "timestamp" DESC NULLS LAST, "id" DESC NULLS LAST);`.


For a controlled publisher-only diagnostic, start the service with `QUEUE_CONSUMER_ENABLED=false`, then run k6 with `PUBLISHER_ONLY=true`. This keeps durable publishing and confirmations enabled while pausing database consumption, and removes read/persistence scenarios from that diagnostic load. The application option defaults to `true`, and the benchmark option defaults to `false`; neither diagnostic setting should be used for normal operation. Afterward, restart with the consumer enabled and allow its durable queue to drain before comparing persisted counts.

An HTTP client timeout does not imply that its batch was discarded. Once RabbitMQ publishing has started, the service cannot safely cancel the durable publish; the message may still be confirmed and persisted after the client disconnects. Clients that retry after an ambiguous timeout must account for the possibility of duplicates.

The k6 summary is written to `benchmark-summary.json`. It reports load-generator scheduling separately from persistence consistency: a run can fail its scheduled load target while still confirming that every accepted log was persisted.

To actually block merges, configure the repository's `main` branch protection to require both checks: `TypeScript and Vitest` and `30k logs/sec benchmark`.
