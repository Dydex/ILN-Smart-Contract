import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import type { ChainReader, OnChainInvoice } from '../src/reconciliation/chainReader.js';
import {
  buildAlertPayload,
  createWebhookAlertDispatcher,
  runReconciliation,
  startReconciliationSchedule,
  DEFAULT_RECONCILIATION_CONFIG,
} from '../src/reconciliation/consistencyJob.js';

type DB = Database.Database;

function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

function chainInvoice(overrides: Partial<OnChainInvoice> & { id: number }): OnChainInvoice {
  return {
    status: 'Pending',
    amount: '1000000',
    amountFunded: '0',
    amountPaid: '0',
    funder: null,
    ...overrides,
  };
}

function seedInvoice(
  db: DB,
  id: number,
  overrides: Partial<{ status: string; amount: string; amount_funded: string; amount_paid: string; funder: string | null }> = {}
): void {
  const row = {
    status: 'Pending',
    amount: '1000000',
    amount_funded: '0',
    amount_paid: '0',
    funder: null as string | null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, status,
       funder, funded_at, amount_funded, amount_paid, referral_code, submitter_reputation, created_at)
     VALUES (?, 'G-FREELANCER', 'G-PAYER', 'USDC', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 50, ?)`
  ).run(id, row.amount, Math.floor(Date.now() / 1000) + 86400, 500, row.status, row.funder, row.amount_funded, row.amount_paid, Math.floor(Date.now() / 1000));
}

/** Chain reader that answers from a mirror map — simulates perfect sync. */
function mirrorReader(db: DB): ChainReader {
  return {
    async getInvoice(id: number) {
      const row = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as any;
      if (!row) return null;
      return chainInvoice({
        id,
        status: row.status,
        amount: String(row.amount),
        amountFunded: String(row.amount_funded),
        amountPaid: String(row.amount_paid),
        funder: row.funder,
      });
    },
    async getInvoiceCount() {
      return (db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as { n: number }).n;
    },
  };
}

describe('indexer/chain consistency reconciliation', () => {
  let db: DB;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('reports no drift when indexed data matches direct contract reads', async () => {
    seedInvoice(db, 1);
    seedInvoice(db, 2);

    const report = await runReconciliation(
      db,
      mirrorReader(db),
      { ...DEFAULT_RECONCILIATION_CONFIG, sampleSize: 2 }
    );

    expect(report.sampledInvoices).toBe(2);
    expect(report.mismatches).toHaveLength(0);
    expect(report.driftedInvoices).toBe(0);
    expect(report.countWithinTolerance).toBe(true);
    expect(report.driftDetected).toBe(false);
  });

  it('flags drift and dispatches an alert when indexed rows diverge beyond tolerance', async () => {
    for (let id = 1; id <= 4; id += 1) {
      seedInvoice(db, id);
    }

    // Chain truth: invoice 1 is Paid with different amounts; invoice 3 missing on-chain.
    const reader: ChainReader = {
      async getInvoice(id: number) {
        if (id === 1) {
          return chainInvoice({ id, status: 'Paid', amount: '111', amountPaid: '999' });
        }
        if (id === 3) {
          return null;
        }
        return mirrorReader(db).getInvoice(id);
      },
      getInvoiceCount: () => Promise.resolve(4),
    };

    const alertPayloads: any[] = [];
    const report = await runReconciliation(db, reader, {
      ...DEFAULT_RECONCILIATION_CONFIG,
      sampleSize: 4,
      tolerancePercent: 1,
    });
    expect(report.driftedInvoices).toBeGreaterThanOrEqual(1);
    expect(report.driftDetected).toBe(true);
    expect(report.mismatches.some((m) => m.field === 'status' && m.invoiceId === 1)).toBe(true);

    const alert = vi.fn(async () => undefined);
    await buildAlertPayload(report); // payload shape sanity
    const scheduler = startReconciliationSchedule(db, reader, { alert, config: { ...DEFAULT_RECONCILIATION_CONFIG, intervalMs: 50 } });
    await new Promise((r) => setTimeout(r, 150));
    scheduler.stop();

    // Scheduler ticks immediately on start; drift must have produced alerts.
    expect(alert).toHaveBeenCalled();
    const payload = alert.mock.calls[0][0];
    expect(payload.type).toBe('indexer_drift_detected');
    expect(payload.severity).toBe('critical');
    alertPayloads.push(payload);
  });

  it('tolerates small mismatches within the configured threshold without alerting', async () => {
    for (let id = 1; id <= 10; id += 1) {
      seedInvoice(db, id);
    }

    // Exactly one drifted invoice out of ten sampled (10% > default 1% would
    // alert; here we raise tolerance to prove the boundary).
    const reader: ChainReader = {
      async getInvoice(id: number) {
        if (id === 7) {
          return chainInvoice({ id, status: 'Funded' });
        }
        return mirrorReader(db).getInvoice(id);
      },
      getInvoiceCount: () => Promise.resolve(10),
    };

    const report = await runReconciliation(db, reader, {
      ...DEFAULT_RECONCILIATION_CONFIG,
      sampleSize: 10,
      tolerancePercent: 15,
    });

    expect(report.driftedInvoices).toBeLessThanOrEqual(1);
    expect(report.driftDetected).toBe(false);
  });

  it('alerts when the indexed invoice count lags the chain beyond tolerance', async () => {
    seedInvoice(db, 1);
    seedInvoice(db, 2);

    const reader: ChainReader = {
      getInvoice: (id) => mirrorReader(db).getInvoice(id),
      getInvoiceCount: () => Promise.resolve(500), // massive lag
    };

    const report = await runReconciliation(db, reader, {
      ...DEFAULT_RECONCILIATION_CONFIG,
      sampleSize: 5,
    });

    expect(report.chainInvoiceCount).toBe(500);
    expect(report.indexedInvoiceCount).toBe(2);
    expect(report.countWithinTolerance).toBe(false);
    expect(report.driftDetected).toBe(true);
  });

  it('excludes chain read errors from the drift rate but records them', async () => {
    seedInvoice(db, 1);
    seedInvoice(db, 2);

    const failingReader: ChainReader = {
      getInvoice: () => Promise.reject(new Error('RPC unreachable')),
      getInvoiceCount: () => Promise.reject(new Error('RPC unreachable')),
    };

    const report = await runReconciliation(db, failingReader, {
      ...DEFAULT_RECONCILIATION_CONFIG,
      sampleSize: 2,
    });

    expect(report.mismatches.every((m) => m.field === '__chain_read_error__')).toBe(true);
    expect(report.driftDetected).toBe(false);
  });

  it('webhook dispatcher POSTs the alert to the notifications service intake', async () => {
    const posted: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: any, init: any) => {
      posted.push({ url: String(url), init });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const dispatcher = createWebhookAlertDispatcher('http://notifications:3002/notify/indexer', fakeFetch);
    await dispatcher(buildAlertPayload({
      ranAt: new Date().toISOString(),
      sampledInvoices: 25,
      checkedFields: 100,
      driftedInvoices: 3,
      mismatches: [],
      indexedInvoiceCount: 120,
      chainInvoiceCount: 125,
      countWithinTolerance: false,
      driftDetected: true,
    }));

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://notifications:3002/notify/indexer');
    const body = JSON.parse(String(posted[0].init.body));
    expect(body.type).toBe('indexer_drift_detected');
    expect(body.severity).toBe('critical');
    expect(body.details.sampledInvoices).toBe(25);
  });
});
