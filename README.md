# LogForge

LogForge is a high-throughput log ingestion and query service built with TypeScript, Fastify, PostgreSQL, and Docker Compose. It accepts valid entries from partially invalid batches, supports composable filters and cursor pagination, returns time-bucketed aggregates, and removes expired logs with a configurable retention worker.

Repository: [github.com/RushdiJa/LogForge](https://github.com/RushdiJa/LogForge)

## Highlights

- Batched log ingestion with per-entry validation
- 50 ms request coalescing before each multi-row database insert
- Exact service, level, time-range, and HSTORE attribute filters
- Case-insensitive message substring search
- Stable keyset pagination ordered by `(timestamp, id)`
- Real-time minute rollups for fast aggregation
- Batched retention cleanup to avoid long delete transactions
- Parameterized SQL and allowlisted dynamic query options
- Docker Compose startup with automatic database migrations
- Integration tests and GitHub Actions CI

## Architecture

```text
HTTP client
    |
    v
Fastify validation
    |
    v
50 ms in-memory micro-batcher
    |
    v
One PostgreSQL statement
    |-- inserts raw rows into logs
    `-- updates log_minute_aggregates atomically
```

PostgreSQL remains the source of truth for all reads and writes. The application does not acknowledge a successful ingestion request until its database write completes.

## Requirements

- Docker
- Docker Compose

Node.js 22 and npm are only needed when running the application or tests outside Docker.

## Quick Start

```bash
git clone https://github.com/RushdiJa/LogForge.git
cd LogForge
docker compose up --build
```

The API is available at `http://localhost:8080`. Verify readiness with:

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{"status":"ok"}
```

Stop the service with:

```bash
docker compose down
```

To remove the local PostgreSQL volume and start with an empty database:

```bash
docker compose down -v
```

> Warning: `docker compose down -v` permanently deletes the local database volume.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://logforge:logforge@localhost:5432/logforge` | PostgreSQL connection string |
| `RETENTION_DAYS` | `30` | Number of days raw logs are retained |

Docker Compose configures `DATABASE_URL` for the PostgreSQL container automatically. The app listens on port `8080`.

## API

### `GET /health`

Returns `200` when PostgreSQL is reachable and the service is ready.

### `POST /logs`

Accepts one or more logs in a batch.

```bash
curl -X POST http://localhost:8080/logs \
  -H 'Content-Type: application/json' \
  -d '{
    "logs": [
      {
        "timestamp": "2026-07-20T14:32:01.123Z",
        "level": "error",
        "service": "checkout",
        "message": "payment declined",
        "attributes": {
          "user_id": "42",
          "region": "eu-west",
          "retries": 3,
          "retryable": true
        }
      }
    ]
  }'
```

Successful response:

```json
{
  "accepted": 1,
  "rejected": []
}
```

Validation is performed per entry. A mixed batch stores the valid entries and reports each invalid entry by array index. The endpoint returns `400` only when all entries are rejected, the JSON is malformed, or the top-level request shape is invalid.

Each log must follow these rules:

| Field | Rules |
| --- | --- |
| `timestamp` | Required ISO 8601 value; no more than five minutes in the future |
| `level` | Required: `debug`, `info`, `warn`, or `error` |
| `service` | Required non-empty string |
| `message` | Required non-empty string |
| `attributes` | Optional flat object; values may be strings, numbers, or booleans |

Attribute numbers and booleans are converted to strings before storage because PostgreSQL HSTORE stores string key/value pairs.

### `GET /logs`

All parameters are optional and may be freely combined.

| Parameter | Meaning |
| --- | --- |
| `service` | Exact service match |
| `level` | Exact level match |
| `since` | Inclusive ISO 8601 start time |
| `until` | Exclusive ISO 8601 end time |
| `attr.<key>` | Attribute equality compared as strings |
| `q` | Case-insensitive message substring |
| `limit` | Result limit; default `100`, range `1` to `1000` |
| `cursor` | Opaque cursor returned by the previous page |

Example:

```bash
curl --get http://localhost:8080/logs \
  --data-urlencode 'service=checkout' \
  --data-urlencode 'level=error' \
  --data-urlencode 'since=2026-07-20T14:00:00Z' \
  --data-urlencode 'until=2026-07-20T15:00:00Z' \
  --data-urlencode 'attr.user_id=42' \
  --data-urlencode 'q=declined' \
  --data-urlencode 'limit=100'
```

Response:

```json
{
  "logs": [
    {
      "id": 123,
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42"
      }
    }
  ],
  "next_cursor": "MTIz"
}
```

Results are ordered by `timestamp DESC, id DESC`. This deterministic ordering and tuple comparison provide keyset pagination without page drift or duplicate results. `next_cursor` is `null` on the final page.

### `GET /logs/aggregate`

Returns log counts grouped into time buckets.

Required parameters:

| Parameter | Values |
| --- | --- |
| `since` | Inclusive ISO 8601 start time |
| `until` | Exclusive ISO 8601 end time |
| `bucket` | `1m`, `5m`, `1h`, or `1d` |

Optional parameters are `service`, `level`, `attr.<key>`, `q`, and `group_by`. `group_by` may be `service` or `level`.

```bash
curl --get http://localhost:8080/logs/aggregate \
  --data-urlencode 'since=2026-07-20T14:00:00Z' \
  --data-urlencode 'until=2026-07-20T15:00:00Z' \
  --data-urlencode 'bucket=5m' \
  --data-urlencode 'group_by=service'
```

Response:

```json
{
  "buckets": [
    {
      "start": "2026-07-20T14:00:00.000Z",
      "group": "checkout",
      "count": 118
    }
  ]
}
```

Buckets are ordered by start time ascending. Empty buckets may be omitted. Without `group_by`, `group` is `null`.

Invalid query or aggregation parameters return:

```json
{
  "error": "<description>"
}
```

## Database Design

### Raw logs

```sql
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE logs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TIMESTAMPTZ(3) NOT NULL,
  level log_level NOT NULL,
  service TEXT NOT NULL,
  message TEXT NOT NULL,
  attributes HSTORE NOT NULL
);
```

Sequential integer IDs are compact, append efficiently to the primary-key B-tree, and provide a deterministic tie-breaker when timestamps are equal.

### Minute rollups

```sql
CREATE TABLE log_minute_aggregates (
  bucket_start TIMESTAMPTZ NOT NULL,
  service TEXT NOT NULL,
  level log_level NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket_start, service, level)
);
```

The rollup table stores only the dimensions needed by the fast aggregation path. A raw insert and its rollup increment happen in one SQL statement, so they commit or fail together.

### Attribute storage

Attributes use PostgreSQL HSTORE because the API accepts a flat string-like map and only requires equality lookup. This avoids the extra structure of JSONB while preserving arbitrary keys. Values are normalized to strings during validation and converted back to a JSON object in API responses with `hstore_to_json`.

No GIN or GiST attribute index is maintained. This is a deliberate ingestion trade-off: those indexes improve attribute-only searches but add considerable write amplification under sustained ingestion.

### Indexes

| Index | Supports |
| --- | --- |
| `logs_pkey (id)` | Cursor row lookup and row identity |
| `logs_timestamp_id_idx (timestamp DESC, id DESC)` | Default order, time ranges, and keyset pagination |
| `logs_service_timestamp_id_idx (service, timestamp DESC, id DESC)` | Service-filtered queries in result order |
| `logs_level_timestamp_id_idx (level, timestamp DESC, id DESC)` | Level-filtered queries in result order |
| Rollup primary key `(bucket_start, service, level)` | Range scans and atomic upserts of minute counts |

The index set stays intentionally small because every additional index must be updated for every inserted log.

## Ingestion Strategy

Incoming requests are validated independently and then coalesced for 50 ms. Concurrent small requests therefore become a larger multi-row `INSERT ... VALUES` operation instead of many small transactions.

The database statement uses a writable CTE:

1. Insert the raw rows into `logs`.
2. Return only `timestamp`, `service`, and `level` from the inserted rows.
3. Group those rows into one-minute counts.
4. Upsert the counts into `log_minute_aggregates`.

Writes are serialized through one application write lane. This reduces transaction and WAL overhead and avoids overwhelming the one-CPU PostgreSQL container with competing inserts.

## Aggregation Strategy

Normal service/level aggregation uses the minute rollup table:

- Complete minutes are read from `log_minute_aggregates`.
- Partial minutes at the beginning and end of the requested range are counted from raw rows.
- Minute counts are combined into `1m`, `5m`, `1h`, or `1d` buckets.

This keeps exact inclusive/exclusive range semantics while avoiding scans over millions of raw logs. Queries using `q` or `attr.<key>` fall back to raw aggregation because messages and attributes are intentionally not duplicated into the rollup table.

## Retention

The retention worker starts with the server and runs once per hour. It calculates the cutoff from `RETENTION_DAYS` and deletes expired raw logs in batches of 5,000:

```sql
WITH expired AS (
  SELECT id
  FROM logs
  WHERE timestamp < $1
  ORDER BY timestamp, id
  LIMIT $2
)
DELETE FROM logs AS l
USING expired
WHERE l.id = expired.id;
```

Small transactions limit lock duration, WAL bursts, and disruption to ingestion. Minute rollups contain counts only and currently remain after raw-log expiration.

## Security

- User values are passed through PostgreSQL parameters.
- Attribute keys are parameters, not SQL identifiers.
- `%`, `_`, and `\` are escaped before `ILIKE` substring matching.
- Levels, bucket sizes, and grouping dimensions are allowlisted.
- Cursors are Base64URL-decoded and accepted only when they contain a positive safe integer.

## Testing and CI

Start the Docker Compose stack before running the integration tests:

```bash
docker compose up --build -d
npm ci
npm run build
npm test
```

The test suite covers ingestion validation, partial rejection, malformed JSON, composable filters, wildcard escaping, stable pagination, aggregation, rollup consistency, and retention.

GitHub Actions performs the following on every push and pull request:

1. Install dependencies with `npm ci`.
2. Compile TypeScript.
3. Start the complete Docker Compose stack.
4. Wait for `/health`.
5. Run the integration tests.
6. Print container logs on failure and tear down the stack.

## Performance Results

The latest local full benchmark was run on 18 August 2026 with `@foothill/logs-benchmark`, k6, a one-million-row seed, 100 logs per POST request, and one aggregate request per second.

### Test environment

| Component | Configuration |
| --- | --- |
| Host | Debian GNU/Linux 13, 8 CPUs, 15.4 GiB RAM |
| Application limit | 0.5 CPU, 256 MiB RAM |
| PostgreSQL limit | 1 CPU, 1 GiB RAM |
| Load generator | k6 0.54.0, 4 CPUs, 1 GiB RAM |
| Seed dataset | 1,000,000 raw logs |
| HTTP batch size | 100 logs |
| Offered load | 15,000 logs/second for 120 seconds |
| Concurrent query rate | 1 aggregate request/second |

### Load scenario

| Metric | Result |
| --- | ---: |
| Accepted records | 1,799,900 |
| Visible records after drain | 1,799,900 |
| Sustained ingestion | 14,999.17 logs/second |
| POST latency p95 | 92.88 ms |
| Aggregate latency p95 | 6 ms |
| HTTP error rate | 0% |
| Dropped generator iterations | 0 |
| Eventual-consistency scenarios | 4/4 passed |
| Benchmark score | 94.89/100 |

The enforced container limits are part of the result. In a separate hosted load run, the application used approximately 50% CPU and 35.2 MiB RAM, while PostgreSQL used approximately one CPU and 199.5 MiB RAM.

Reproduce the benchmark with:

```bash
npx --yes "github:Ahmad-Abbas-Foothill/logs-benchmark-cli#992d9c8" \
  --compose ./docker-compose.yml \
  --full \
  --seed 6122026 \
  --generator-cpus 4
```

Results vary with host CPU speed and generator capacity, so the environment and enforced limits should always be reported with the score.

## Optimizations Applied

- 50 ms request coalescing and multi-row inserts
- A small PostgreSQL connection pool with serialized writes
- Atomic raw insertion and rollup update
- Pre-aggregated minute counts for common aggregation queries
- Raw-row reads only for partial-minute boundaries
- Keyset pagination instead of `OFFSET`
- Three query-aligned B-tree indexes instead of broad write-heavy indexes
- Compact sequential integer IDs
- Batched retention deletion

## Known Limitations

- `q` uses `ILIKE '%term%'`. A selective query often completes quickly because the timestamp index can stop after the limit, but a missing term may scan the entire table. A manual `EXPLAIN ANALYZE` over approximately two million rows took about 3.76 seconds for a term that did not exist.
- No trigram message index or GIN attribute index is maintained because the write cost reduced ingestion performance in this workload.
- Aggregations containing `q` or `attr.<key>` scan raw rows because the minute rollup does not store messages or attributes.
- The micro-batch queue is process-local. A process crash can interrupt requests that have not yet reached PostgreSQL, although successful responses are returned only after the database write completes.
- The retention worker deletes raw logs only; summary rollup rows are not currently expired.
- Throughput above the baseline can increase queueing latency because one PostgreSQL writer is intentionally used under the one-CPU database limit.

## Project Structure

```text
src/
  app.ts                 Fastify application
  server.ts              Server startup and retention worker
  db.ts                  PostgreSQL pool
  health.ts              Readiness endpoint
  retention.ts           Batched retention cleanup
  logs/
    route.ts              HTTP routes
    controller.ts         Request/response handling
    validate.ts           Ingestion and query validation
    batcher.ts            Request coalescing
    repository.ts         Parameterized persistence and queries
    type.ts               TypeScript types
  test/                   Integration tests
migrations/               PostgreSQL schema and indexes
docker-compose.yml        Resource-limited application stack
Dockerfile                Production application image
```

## Design Trade-offs

LogForge is optimized for sustained writes and the required aggregation workload. It favors a small number of useful B-tree indexes and compact rollups over indexing every possible search dimension. This keeps ingestion near the 15,000 logs/second target under strict CPU and memory limits while still providing fast common queries and exact API behavior.

## License

ISC
