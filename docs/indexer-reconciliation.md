# Indexer Reconciliation

Continuous drift detection between the ILN indexer's SQLite state and the
on-chain invoice-liquidity contract. Productionized from
[`tests/e2e/indexerConsistency.test.ts`](../tests/e2e/indexerConsistency.test.ts):
instead of asserting consistency once inside CI, a scheduled job periodically
spot-checks live indexed data against direct contract reads and alerts through
the notifications service when drift exceeds tolerance.

## How it works

1. **Sample** — each run selects up to `RECONCILIATION_SAMPLE_SIZE` random invoice ids from the `invoices` table (`ORDER BY RANDOM()`).
2. **Read chain truth** — for each sampled id the job performs a read-only Soroban simulation of `get_invoice(invoice_id)` via [`indexer/src/reconciliation/chainReader.ts`](../indexer/src/reconciliation/chainReader.ts) (no fees, no submission). It also calls `get_invoice_count()`.
3. **Compare** — per-invoice fields compared: `status`, `amount`, `amount_funded`, `amount_paid`. The global indexed count is compared against `get_invoice_count()`.
4. **Alert** — if drift beyond tolerance is detected, an `indexer_drift_detected` payload (severity `critical`) is POSTed to `RECONCILIATION_ALERT_URL` — point this at the notifications service intake (e.g. `/notify/slack` or any webhook subscription registered there, see [docs/notifications-operations.md](notifications-operations.md)).

## Cadence & thresholds

| Setting | Env var | Default | Rationale |
| --- | --- | --- | --- |
| Run interval | `RECONCILIATION_INTERVAL_MS` | `900000` (**15 minutes**) | Fast enough to bound silent-drift windows well under one backup cycle, cheap enough that 25 simulations × 96 runs/day are negligible RPC load |
| Sample size | `RECONCILIATION_SAMPLE_SIZE` | `25` invoices/run | ~99% chance of catching a defect affecting ≥ 18% of invoices within one run, while keeping run cost flat as the table grows |
| Invoice drift tolerance | `RECONCILIATION_TOLERANCE_PERCENT` | `1%` of sampled invoices | One drifted invoice in 25 trips the alert; anything below is treated as noise from in-flight transactions |
| Count lag tolerance | derived | `max(5, ⌈1% of chain count⌉)` | Absorbs normal ingestion lag between chain settlement and Horizon stream delivery |

Chain-read errors (RPC outages) are recorded in the report but deliberately
**excluded** from the drift rate — infrastructure flakiness must not page
on-call for data that was never mis-ingested. Sustained RPC failure surfaces
through normal monitoring instead.

## Operating modes

```bash
# One-shot check (exit code 2 on drift) — suitable for cron/CI
pnpm --filter @iln/indexer exec tsx scripts/reconcile.ts --once

# Continuous schedule with alerting
RECONCILIATION_ALERT_URL=https://notifications.example/notify/slack \
  pnpm --filter @iln/indexer exec tsx scripts/reconcile.ts --watch
```

In-process scheduling is also available: start the indexer with
`RECONCILIATION_ENABLED=true` and the scheduler runs alongside ingestion in
[`indexer/src/index.ts`](../indexer/src/index.ts).

### Alert payload contract

```json
{
  "type": "indexer_drift_detected",
  "severity": "critical",
  "summary": "Indexer drift detected: 3/25 sampled invoices drifted (...)",
  "details": { "ranAt": "...", "driftedInvoices": 3, "mismatches": [ ... ] },
  "firedAt": "2026-08-26T09:00:00.000Z"
}
```

On-call response: follow [docs/indexer-incident-runbook.md](indexer-incident-runbook.md).
Field-level mismatches on specific ledgers are fixed by checkpoint replay;
whole-database corruption falls back to restore-from-backup
([docs/indexer-operations.md](indexer-operations.md)).

## Test coverage

Unit tests in [`indexer/tests/reconciliation.test.ts`](../indexer/tests/reconciliation.test.ts)
exercise the full decision matrix against an injected fake chain reader:
clean sync, field-level drift + missing-on-chain, tolerance boundary,
count-lag detection, chain-read-error exclusion, and webhook dispatch shape.
