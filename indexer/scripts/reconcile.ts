/**
 * Reconciliation CLI.
 *
 * One-shot run (default) or continuous schedule (--watch):
 *   tsx indexer/scripts/reconcile.ts --once
 *   tsx indexer/scripts/reconcile.ts --watch
 *
 * Environment:
 *   DB_PATH                        SQLite file (default ./indexer.db)
 *   SOROBAN_RPC_URL                Soroban RPC endpoint
 *   ILN_CONTRACT_ID / CONTRACT_ID  invoice-liquidity contract address
 *   NETWORK_PASSPHRASE             network passphrase (default Testnet)
 *   RECONCILIATION_ALERT_URL       notifications service intake URL for alerts
 *   RECONCILIATION_INTERVAL_MS / _SAMPLE_SIZE / _TOLERANCE_PERCENT  (see consistencyJob.ts)
 */

import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import {
  createWebhookAlertDispatcher,
  startReconciliationSchedule,
} from '../src/reconciliation/consistencyJob.js';
import { DEFAULT_RECONCILIATION_CONFIG } from '../src/reconciliation/consistencyJob.js';
import { SorobanChainReader } from '../src/reconciliation/chainReader.js';

const watch = process.argv.includes('--watch');

if (!config.contractId) {
  console.error('ILN_CONTRACT_ID/CONTRACT_ID is required for chain reconciliation.');
  process.exit(1);
}

const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const networkPassphrase =
  process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';

const db = new Database(config.dbPath);
const chainReader = new SorobanChainReader({
  rpcUrl,
  contractId: config.contractId,
  networkPassphrase,
});

const alertUrl = process.env.RECONCILIATION_ALERT_URL;
const alert = alertUrl ? createWebhookAlertDispatcher(alertUrl) : undefined;
if (!alertUrl) {
  console.warn('RECONCILIATION_ALERT_URL not set — drift alerts will be logged only.');
}

if (watch) {
  console.log(
    `Starting reconciliation watch every ${DEFAULT_RECONCILIATION_CONFIG.intervalMs}ms ` +
      `(sample=${DEFAULT_RECONCILIATION_CONFIG.sampleSize}, tolerance=${DEFAULT_RECONCILIATION_CONFIG.tolerancePercent}%).`
  );
  const scheduler = startReconciliationSchedule(db, chainReader, { alert });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      scheduler.stop();
      db.close();
      process.exit(0);
    });
  }
} else {
  import('../src/reconciliation/consistencyJob.js')
    .then(({ runReconciliation }) => runReconciliation(db, chainReader))
    .then((report) => {
      if (alert && report.driftDetected) {
        return alert({
          type: 'indexer_drift_detected',
          severity: 'critical',
          summary: `Indexer drift detected: ${report.driftedInvoices}/${report.sampledInvoices} sampled invoices drifted.`,
          details: report,
          firedAt: new Date().toISOString(),
        }).then(() => report);
      }
      return report;
    })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      db.close();
      process.exitCode = report.driftDetected ? 2 : 0;
    })
    .catch((error) => {
      console.error(`Reconciliation crashed: ${error instanceof Error ? error.message : String(error)}`);
      db.close();
      process.exitCode = 1;
    });
}
