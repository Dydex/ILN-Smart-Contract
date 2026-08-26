# Indexer High Availability & Ingestion Safety

## Constraint (single writer)

The indexer stores state in **SQLite** (`DB_PATH`). Horizon event ingestion (`EventListener`) advances a shared cursor in `indexer_state` and upserts invoices/events. **Two concurrent ingestors against the same database will race** and can duplicate work or corrupt cursor ordering.

There is **no** Postgres advisory lock in this deployment. Safety is provided by:

1. **SQLite lease-based leader election** (`indexer/src/ingestion/ingestionLock.ts`) when ingestion is enabled.
2. An explicit **`INGESTION_ENABLED`** flag so API replicas can scale horizontally without running a writer.

## Recommended topology

```
                 ┌─────────────────────┐
  Horizon  ─────►│ Indexer writer (#1) │──┐
                 │ INGESTION_ENABLED=1 │  │
                 │ holds ingestion lease│  ├── shared SQLite volume
                 └─────────────────────┘  │   (or primary + replicas
                 ┌─────────────────────┐  │    via backup/restore)
  Clients  ─────►│ Indexer API (#2..N) │◄─┘
                 │ INGESTION_ENABLED=0 │
                 └─────────────────────┘
```

| Role | `INGESTION_ENABLED` | Notes |
| --- | --- | --- |
| Writer | `true` (default) | Contends for the lease; only the leader runs `EventListener.start()` |
| Standby writer | `true` | Polls until the lease expires or is released, then takes over |
| Read API replica | `false` | Serves REST/GraphQL/WebSocket reads only; never starts ingestion |

SQLite is not an ideal multi-writer network filesystem database. Prefer **one writer process** attached to the DB file (local disk or a single-node volume). Scale **read** traffic with `INGESTION_ENABLED=false` replicas that either:

- share a **read replica** copy of the DB refreshed from the writer, or
- sit behind the same writer host for now (scale the Node HTTP layer only after moving to a networked DB).

## Lock verification

Automated coverage: `indexer/tests/ingestionLock.test.ts`.

Manual check on a running writer:

```bash
sqlite3 "$DB_PATH" "SELECT state_value FROM indexer_state WHERE state_key = 'ingestion_leader';"
curl -sS localhost:3001/health | jq .ingestion
```

Expect `ingestion.isLeader` true on the active writer and lag within threshold.

## Failure behavior

- If the leader crashes, its lease expires after ~15s (`leaseMs`); a standby acquires and resumes from `last_processed_cursor`.
- Event inserts use `UNIQUE(transaction_hash, event_index)` to make accidental double-processing fail closed on conflict rather than silently duplicating rows.
