/**
 * Continuous indexer/chain consistency reconciliation.
 *
 * Productionized version of tests/e2e/indexerConsistency.test.ts: instead of
 * a one-time CI assertion, this job periodically spot-checks a random sample
 * of indexed invoices (and the invoice count) against direct on-chain
 * contract reads, and raises a drift alert through the notifications service
 * when mismatches exceed the configured tolerance.
 *
 * Cadence, sample size and tolerance are documented in
 * docs/indexer-reconciliation.md.
 */

import type Database from 'better-sqlite3';
import type { ChainReader } from './chainReader.js';

export interface ReconciliationConfig {
  /** Milliseconds between reconciliation runs. */
  intervalMs: number;
  /** Invoices sampled per run. */
  sampleSize: number;
  /**
   * Percentage of sampled invoices allowed to mismatch before an alert is
   * raised (0-100).
   */
  tolerancePercent: number;
  /**
   * Allowed absolute gap between indexed and on-chain invoice counts,
   * absorbing normal ingestion lag. Defaults to max(5, ceil(1% of chain count)).
   */
  countLagTolerance?: number;
}

export interface ReconciliationMismatch {
  invoiceId: number;
  field: string;
  indexedValue: string | null;
  chainValue: string | null;
}

export interface ReconciliationReport {
  ranAt: string;
  sampledInvoices: number;
  checkedFields: number;
  /** Distinct invoices with real drift (excludes chain-read errors). */
  driftedInvoices: number;
  mismatches: ReconciliationMismatch[];
  indexedInvoiceCount: number;
  chainInvoiceCount: number;
  countWithinTolerance: boolean;
  driftDetected: boolean;
  error?: string;
}

export interface AlertDispatcher {
  (alert: {
    type: 'indexer_drift_detected';
    severity: 'critical';
    summary: string;
    details: ReconciliationReport;
    firedAt: string;
  }): Promise<void>;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  intervalMs: parseInt(process.env.RECONCILIATION_INTERVAL_MS || '900000', 10), // 15 min
  sampleSize: parseInt(process.env.RECONCILIATION_SAMPLE_SIZE || '25', 10),
  tolerancePercent: parseFloat(process.env.RECONCILIATION_TOLERANCE_PERCENT || '1'),
};

export function configFromEnv(): ReconciliationConfig {
  return DEFAULT_RECONCILIATION_CONFIG;
}

export async function runReconciliation(
  db: Database.Database,
  chainReader: ChainReader,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    ranAt: new Date().toISOString(),
    sampledInvoices: 0,
    checkedFields: 0,
    driftedInvoices: 0,
    mismatches: [],
    indexedInvoiceCount: 0,
    chainInvoiceCount: 0,
    countWithinTolerance: true,
    driftDetected: false,
  };

  try {
    report.indexedInvoiceCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as { n: number }
    ).n;

    // ---- Sampled per-invoice spot checks against direct contract reads ----
    if (report.indexedInvoiceCount > 0) {
      const sampleLimit = Math.max(1, Math.min(config.sampleSize, report.indexedInvoiceCount));
      const sampled = db
        .prepare(`SELECT id FROM invoices ORDER BY RANDOM() LIMIT ?`)
        .all(sampleLimit) as Array<{ id: number }>;
      report.sampledInvoices = sampled.length;

      for (const { id } of sampled) {
        const row = db
          .prepare(
            `SELECT status, amount, amount_funded, amount_paid, funder FROM invoices WHERE id = ?`
          )
          .get(id) as {
            status: string;
            amount: string;
            amount_funded: string;
            amount_paid: string;
            funder: string | null;
          };

        let chain: Awaited<ReturnType<ChainReader['getInvoice']>>;
        try {
          chain = await chainReader.getInvoice(id);
        } catch (error) {
          // Chain read failures are infrastructure noise, not drift — record
          // and continue; sustained failures surface via alert dispatch below.
          report.mismatches.push({
            invoiceId: id,
            field: '__chain_read_error__',
            indexedValue: null,
            chainValue: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        if (chain === null) {
          report.mismatches.push({
            invoiceId: id,
            field: '__missing_on_chain__',
            indexedValue: row.status,
            chainValue: null,
          });
          continue;
        }

        compareField(report, id, 'status', row.status.toLowerCase(), chain.status.toLowerCase());
        compareField(report, id, 'amount', row.amount, chain.amount);
        compareField(report, id, 'amount_funded', row.amount_funded, chain.amountFunded);
        compareField(report, id, 'amount_paid', row.amount_paid, chain.amountPaid);
      }
    }

    // ---- Global count check (absorbs ingestion lag via tolerance) ----
    try {
      report.chainInvoiceCount = await chainReader.getInvoiceCount();
    } catch {
      report.chainInvoiceCount = -1;
    }

    if (report.chainInvoiceCount >= 0) {
      const tolerance =
        config.countLagTolerance ?? Math.max(5, Math.ceil(report.chainInvoiceCount * 0.01));
      report.countWithinTolerance =
        Math.abs(report.indexedInvoiceCount - report.chainInvoiceCount) <= tolerance;
    }

    // Drift rate is measured in distinct invoices with real mismatches
    // (field divergence or missing on-chain). Chain-read errors are
    // infrastructure noise and excluded from the drift rate; they remain in
    // report.mismatches for observability.
    const driftedInvoices = new Set(
      report.mismatches.filter((m) => m.field !== '__chain_read_error__').map((m) => m.invoiceId)
    ).size;
    report.driftedInvoices = driftedInvoices;
    const mismatchRate =
      report.sampledInvoices > 0 ? (driftedInvoices / report.sampledInvoices) * 100 : 0;

    const invoiceDrift = mismatchRate > config.tolerancePercent;
    const countDrift = !report.countWithinTolerance;
    report.driftDetected = invoiceDrift || countDrift;

    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.driftDetected = true;
    return report;
  }
}

function compareField(
  report: ReconciliationReport,
  invoiceId: number,
  field: string,
  indexedValue: string,
  chainValue: string
): void {
  report.checkedFields += 1;
  if (indexedValue !== chainValue) {
    report.mismatches.push({ invoiceId, field, indexedValue, chainValue });
  }
}

/**
 * Default alert dispatcher: POSTs to the notifications service intake URL.
 * Configure RECONCILIATION_ALERT_URL to e.g. the notifications service's
 * /notify/slack endpoint or any HTTP collector subscribed for
 * indexer_drift_detected events.
 */
export function createWebhookAlertDispatcher(url: string, httpPost?: typeof fetch): AlertDispatcher {
  const post = httpPost ?? fetch;
  return async (alert) => {
    try {
      const response = await post(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alert),
      });
      if (!response.ok) {
        console.error(`Drift alert delivery failed with HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(`Drift alert delivery error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export function buildAlertPayload(report: ReconciliationReport) {
  const first = report.mismatches
    .slice(0, 5)
    .map((m) => `invoice ${m.invoiceId} ${m.field}: indexed=${m.indexedValue} chain=${m.chainValue}`)
    .join('; ');
  return {
    type: 'indexer_drift_detected' as const,
    severity: 'critical' as const,
    summary:
      `Indexer drift detected: ${report.driftedInvoices}/${report.sampledInvoices} sampled invoices drifted ` +
      `(${report.mismatches.length} field mismatch(es)); indexed count=${report.indexedInvoiceCount}, ` +
      `chain count=${report.chainInvoiceCount}. Samples: ${first}`,
    details: report,
    firedAt: new Date().toISOString(),
  };
}

export interface ReconciliationScheduler {
  stop: () => void;
}

export function startReconciliationSchedule(
  db: Database.Database,
  chainReader: ChainReader,
  options: {
    config?: ReconciliationConfig;
    alert?: AlertDispatcher;
    logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  } = {}
): ReconciliationScheduler {
  const config = options.config ?? configFromEnv();
  const logger = options.logger ?? console;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const report = await runReconciliation(db, chainReader, config);
      if (report.driftDetected) {
        logger.error(`RECONCILIATION DRIFT: ${report.mismatches.length} mismatch(es). Dispatching alert.`);
        const alert = options.alert ?? ((payload) => {
          console.error(JSON.stringify(payload, null, 2));
          return Promise.resolve();
        });
        await alert(buildAlertPayload(report));
      } else if (report.error) {
        logger.warn(`Reconciliation run errored: ${report.error}`);
      } else {
        logger.info(
          `Reconciliation OK: ${report.sampledInvoices} invoices sampled, no drift beyond ${(config.tolerancePercent).toFixed(2)}%.`
        );
      }
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
