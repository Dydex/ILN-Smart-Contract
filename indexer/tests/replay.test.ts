import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { createSqlEventRepository } from '../src/db/eventRepository.js';
import type {
  DecodedContractEvent,
  HorizonTransactionRecord,
} from '../src/ingestion/eventListener.js';
import { runReplay } from '../src/ingestion/replay.js';

type DB = Database.Database;

const CONTRACT = 'CDEMOCONTRACT';

function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

function makeTx(ledger: number, hash: string): HorizonTransactionRecord {
  return {
    hash,
    ledger,
    created_at: new Date(Date.UTC(2026, 7, 26, ledger % 24)).toISOString(),
    paging_token: String(1200000000 + ledger),
    result_meta_xdr: 'unused-by-injected-decoder',
  };
}

interface FakeEventSpec {
  ledger: number;
  hash: string;
  events: DecodedContractEvent[];
}

/**
 * Builds an injectable decode function + Horizon JSON page fetcher from a
 * compact fixture, so tests avoid crafting XDR transaction meta by hand.
 */
function makeHorizonFixture(specs: FakeEventSpec[], contractId: string) {
  const records = specs.map((spec) => ({
    ...makeTx(spec.ledger, spec.hash),
    _links: {},
  }));

  const decodedByHash = new Map(specs.map((s) => [s.hash, s.events]));

  const fetchImpl = (async (url: any) => {
    const parsed = new URL(String(url));
    const cursor = Number(parsed.searchParams.get('cursor') || 0);
    const limit = Number(parsed.searchParams.get('limit') || 200);
    const eligible = records.filter((r) => r.ledger > cursor && r.ledger <= limit ? true : r.ledger > cursor);

    // Simulate a single page containing everything after the cursor.
    const pageRecords = eligible.slice(0, limit);
    const hasMore = eligible.length > pageRecords.length;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: hasMore ? pageRecords : eligible },
        _links: hasMore
          ? { next: { href: `${parsed.origin}/transactions?cursor=${pageRecords[pageRecords.length - 1].paging_token}&order=asc&limit=${limit}` } }
          : {},
      }),
    } as Response;
  }) as typeof fetch;

  const decodeTransactionEvents = (record: HorizonTransactionRecord): DecodedContractEvent[] =>
    decodedByHash.get(record.hash) ?? [];

  return { fetchImpl, decodeTransactionEvents };
}

function submittedEvent(invoiceId: number, amount: string): DecodedContractEvent[] {
  return [
    {
      contractId: CONTRACT,
      rawEventType: 'submitted',
      contractEventType: 'InvoiceSubmitted',
      topics: ['submitted'],
      data: { invoice_id: invoiceId, amount, token: 'USDC', status: 'Pending' },
    },
  ];
}

function fundedEvent(invoiceId: number, funder: string, amountFunded: string): DecodedContractEvent[] {
  return [
    {
      contractId: CONTRACT,
      rawEventType: 'funded',
      contractEventType: 'InvoiceFunded',
      topics: ['funded'],
      data: {
        invoice_id: invoiceId,
        funder,
        amount_funded: amountFunded,
        status: 'Funded',
      },
    },
  ];
}

function paidEvent(invoiceId: number, amountPaid: string): DecodedContractEvent[] {
  return [
    {
      contractId: CONTRACT,
      rawEventType: 'paid',
      contractEventType: 'InvoicePaid',
      topics: ['paid'],
      data: { invoice_id: invoiceId, amount_paid: amountPaid, status: 'Paid', lp: 'G-LP' },
    },
  ];
}

describe('indexer checkpoint replay', () => {
  let db: DB;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('restores correct derived state after intentional corruption without duplicating events', async () => {
    // --- Phase 1: healthy ingestion up to ledger 101 ---
    const initial = makeHorizonFixture(
      [
        { ledger: 100, hash: 'tx-submitted', events: submittedEvent(1, '1000000') },
        { ledger: 101, hash: 'tx-funded', events: fundedEvent(1, 'GLP-FUNDER', '1000000') },
      ],
      CONTRACT
    );

    await runReplay({
      repository: createSqlEventRepository(db),
      horizonUrl: 'https://horizon.example',
      contractAddress: CONTRACT,
      decodeTransactionEvents: initial.decodeTransactionEvents,
      fetchImpl: initial.fetchImpl,
      fromLedger: 99,
      toLedger: 102,
    });

    let row = db.prepare(`SELECT * FROM invoices WHERE id = 1`).get() as any;
    expect(row.status).toBe('Funded');
    expect(row.amount_funded).toBe('1000000');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(2);

    // Checkpoint recorded at the last replayed ledger.
    const repo = createSqlEventRepository(db);
    expect(repo.getState('last_processed_ledger')).toBe('101');

    // --- Phase 2: indexer bug corrupts derived state at ledger 103 ---
    db.prepare(`UPDATE invoices SET status = 'Disputed', amount_funded = '1', funder = NULL WHERE id = 1`).run();
    row = db.prepare(`SELECT * FROM invoices WHERE id = 1`).get() as any;
    expect(row.status).toBe('Disputed');

    // --- Phase 3: replay from before the corruption fixes derived state ---
    const repair = makeHorizonFixture(
      [
        { ledger: 100, hash: 'tx-submitted', events: submittedEvent(1, '1000000') },
        { ledger: 101, hash: 'tx-funded', events: fundedEvent(1, 'GLP-FUNDER', '1000000') },
        { ledger: 102, hash: 'tx-paid', events: paidEvent(1, '970000') },
      ],
      CONTRACT
    );

    const result = await runReplay({
      repository: createSqlEventRepository(db),
      horizonUrl: 'https://horizon.example',
      contractAddress: CONTRACT,
      decodeTransactionEvents: repair.decodeTransactionEvents,
      fetchImpl: repair.fetchImpl,
      fromLedger: 100,
      toLedger: 103,
    });

    expect(result.transactionsProcessed).toBe(3);
    expect(result.failedTransactions).toBe(0);

    // Derived state restored to chain truth (including the newer `paid` event).
    row = db.prepare(`SELECT * FROM invoices WHERE id = 1`).get() as any;
    expect(row.status).toBe('Paid');
    expect(row.funder).toBe('G-LP');
    // InvoicePaid derives amount_funded from the LP payout, matching live ingestion.
    expect(row.amount_funded).toBe('970000');
    expect(row.amount_paid).toBe('970000');

    // Events deduplicated — no duplicate rows despite reprocessing.
    const eventCount = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    expect(eventCount).toBe(3);
    const distinctTxHashes = (
      db.prepare(`SELECT COUNT(DISTINCT transaction_hash) AS n FROM events`).get() as { n: number }
    ).n;
    expect(distinctTxHashes).toBe(eventCount);

    // Cursor advanced past the replayed range for live-stream handoff.
    expect(Number(createSqlEventRepository(db).getState('last_processed_ledger'))).toBe(102);
  });

  it('replays only the requested ledger window and stops at --to-ledger boundary', async () => {
    const fixture = makeHorizonFixture(
      [
        { ledger: 50, hash: 'tx-a', events: submittedEvent(2, '500000') },
        { ledger: 60, hash: 'tx-b', events: fundedEvent(2, 'GLP-2', '500000') },
        { ledger: 70, hash: 'tx-c', events: paidEvent(2, '480000') },
      ],
      CONTRACT
    );

    const result = await runReplay({
      repository: createSqlEventRepository(db),
      horizonUrl: 'https://horizon.example',
      contractAddress: CONTRACT,
      decodeTransactionEvents: fixture.decodeTransactionEvents,
      fetchImpl: fixture.fetchImpl,
      fromLedger: 50,
      toLedger: 65, // excludes ledger 70
    });

    expect(result.transactionsProcessed).toBe(2); // ledgers 50 and 60 only
    expect(result.lastProcessedLedger).toBe(60);
    const statuses = db.prepare(`SELECT status FROM invoices WHERE id = 2`).get() as { status: string };
    expect(statuses.status).toBe('Funded');
  });

  it('continues past transactions that fail to process and reports them', async () => {
    const failingDecode = (record: HorizonTransactionRecord): DecodedContractEvent[] => {
      if (record.hash === 'tx-bad') {
        throw new Error('simulated decoder failure');
      }
      if (record.hash === 'tx-good') {
        return submittedEvent(3, '250000');
      }
      return [];
    };

    const fixture = makeHorizonFixture(
      [
        { ledger: 10, hash: 'tx-bad', events: [] },
        { ledger: 11, hash: 'tx-good', events: [] },
      ],
      CONTRACT
    );
    // Override decode to throw on tx-bad; fixture returns [] otherwise.
    const fetchWithThrow = fixture.fetchImpl;

    const errors: unknown[] = [];
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args),
    };

    const result = await runReplay({
      repository: createSqlEventRepository(db),
      horizonUrl: 'https://horizon.example',
      contractAddress: CONTRACT,
      decodeTransactionEvents: failingDecode,
      fetchImpl: fetchWithThrow,
      fromLedger: 5,
      toLedger: 20,
      logger,
    });

    expect(result.failedTransactions).toBe(1);
    // Both transactions were attempted — the listener logs-and-continues on
    // per-transaction failures, so the good one still lands.
    expect(result.transactionsProcessed).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
    const invoice = db.prepare(`SELECT id FROM invoices WHERE id = 3`).get() as { id: number } | undefined;
    expect(invoice?.id).toBe(3);
  });
});
