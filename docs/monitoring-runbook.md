# Indexer & Notifications Monitoring Runbook

Operational monitoring for the ILN indexer HTTP/GraphQL API and the notifications service. Complements [indexer-incident-runbook.md](./indexer-incident-runbook.md) and [notifications-operations.md](./notifications-operations.md).

## 1. What `/health` checks (indexer)

`GET /health` is the primary liveness/readiness probe. It is **excluded from rate limiting** so uptime monitors are never throttled.

| Field | Meaning |
| --- | --- |
| `status` | `ok` (HTTP 200) or `degraded` (HTTP 503) |
| `db` | `connected` if `SELECT 1` succeeds against the SQLite DB |
| `horizon` | `connected` / `disconnected` / `unknown` — Horizon root endpoint reachability |
| `ingestion.enabled` | Whether this process runs the writer (`INGESTION_ENABLED`) |
| `ingestion.isLeader` | Whether a valid ingestion lease is present in `indexer_state` |
| `ingestion.lastLedger` | Last processed ledger from `indexer_state.last_processed_ledger` |
| `ingestion.lastCursor` | Horizon paging token cursor |
| `ingestion.lagLedgers` | `chainTip - lastLedger` when both are known |
| `lastEventAt` | ISO timestamp of the newest row in `events` |
| `checkedAt` | Probe time |

**Healthy** requires: DB connected, Horizon not `disconnected`, and lag ≤ `HEALTH_MAX_LAG_LEDGERS` (default `50`).

Example:

```bash
curl -sS https://indexer.example/health | jq .
```

## 2. Recommended external monitoring

### Uptime checks

| Check | Interval | Timeout | Alert when |
| --- | --- | --- | --- |
| `GET /health` (indexer) | 30–60s | 5s | Non-200 for 2 consecutive intervals, or body `status != "ok"` |
| `GET /health` (notifications) | 30–60s | 5s | Non-200 for 2 consecutive intervals |
| TLS certificate expiry | daily | — | < 14 days remaining |

Use a multi-region checker (e.g. Pingdom, Better Uptime, CloudWatch Synthetics, Grafana Synthetic Monitoring). Prefer validating JSON `status` over HTTP code alone so a process that returns 200 with a stale stub cannot hide degradation.

### Alert thresholds (indexer)

| Signal | Warning | Critical |
| --- | --- | --- |
| `/health` degraded | 1–2 minutes | ≥ 5 minutes |
| `ingestion.lagLedgers` | > 25 for 5 minutes | > `HEALTH_MAX_LAG_LEDGERS` (default 50) for 5 minutes |
| HTTP 5xx rate (API) | > 1% for 5 minutes | > 5% for 5 minutes |
| HTTP 429 rate (anonymous) | Sustained > 10% may indicate attack or undersized limits | Investigate + scale / tune `RATE_LIMIT_*` |
| Process restart count | > 3 / hour | Crash loop |

### Notifications

Follow [notifications-operations.md](./notifications-operations.md) for delivery latency, circuit-breaker open rate, and webhook failure ratio. Ensure the notifications `/health` (or equivalent) is on the same on-call rotation as the indexer.

## 3. Log retention

| Stream | Retention | Notes |
| --- | --- | --- |
| Indexer application logs | ≥ 30 days hot, ≥ 90 days cold | Include ingestion leader acquire/release, Horizon stream errors |
| Notifications delivery logs | ≥ 30 days hot | Retain HMAC verification failures for abuse review |
| Access / reverse-proxy logs | ≥ 14 days | Needed for rate-limit / DoS forensics |
| Database backups | Daily + retain ≥ 7 days | See incident runbook restore paths |

Ship logs to a centralized store (CloudWatch, Loki, Datadog). Do not rely on container ephemeral disk alone.

## 4. On-call escalation

1. **Page primary on-call** when critical health alerts fire or lag is critical.
2. **Acknowledge within 15 minutes**; triage with `/health` + recent deploy changelog.
3. If ingestion is stuck: confirm a single writer holds the lease (see [indexer-ha.md](./indexer-ha.md)); restart the writer replica if the lease is stale and no leader renews.
4. **Escalate to secondary** after 30 minutes without mitigation, or immediately for suspected data corruption (use [indexer-incident-runbook.md](./indexer-incident-runbook.md)).
5. **Customer communication** for API staleness: use the user-facing template in the incident runbook.

Suggested routing: PagerDuty/Opsgenie service `iln-indexer` + `iln-notifications`, business-hours low-urgency for warnings, 24/7 high-urgency for critical.

## 5. Related configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RATE_LIMIT_ANON_MAX` | `60` | Anonymous requests / window |
| `RATE_LIMIT_API_KEY_MAX` | `600` | API-key requests / window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length |
| `GRAPHQL_MAX_DEPTH` | `8` | Reject deeper GraphQL queries |
| `GRAPHQL_MAX_COMPLEXITY` | `200` | Reject expensive GraphQL queries |
| `HEALTH_MAX_LAG_LEDGERS` | `50` | Degraded if lag exceeds this |
| `INGESTION_ENABLED` | `true` | Set `false` on read-only API replicas |

## 6. Checklist status

When this runbook is wired into production uptime checks and on-call, mark **Monitoring configured** complete on [mainnet-launch-checklist.md](./mainnet-launch-checklist.md).
