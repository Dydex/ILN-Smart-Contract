import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb, seedEvent, seedInvoice } from './helpers.js';

describe('GET /health', () => {
  it('reports ok when db is up and lag is within threshold', async () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO indexer_state (state_key, state_value) VALUES (?, ?)`
    ).run('last_processed_ledger', '1000');
    seedInvoice(db, { id: 1 });
    seedEvent(db, { invoice_id: 1, ledger: 1000, timestamp: 1_700_000_000 });

    const app = createTestApp(db, {
      health: {
        horizonUrl: 'http://horizon.test',
        maxLagLedgers: 50,
        getChainTipLedger: async () => 1010,
        ingestionEnabled: true,
      },
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.horizon).toBe('connected');
    expect(res.body.ingestion.lastLedger).toBe(1000);
    expect(res.body.ingestion.lagLedgers).toBe(10);
    expect(res.body.lastEventAt).toBeTruthy();
  });

  it('reports degraded when ingestion lag exceeds threshold', async () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO indexer_state (state_key, state_value) VALUES (?, ?)`
    ).run('last_processed_ledger', '100');

    const app = createTestApp(db, {
      health: {
        maxLagLedgers: 20,
        getChainTipLedger: async () => 200,
        ingestionEnabled: true,
      },
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ingestion.lagLedgers).toBe(100);
  });

  it('reports degraded when the database is unreachable', async () => {
    const db = createTestDb();
    // Simulate DB failure without closing the handle (avoids native segfaults).
    db.prepare = (() => {
      throw new Error('db unavailable');
    }) as typeof db.prepare;

    const app = createTestApp(db, {
      health: {
        getChainTipLedger: async () => 1,
      },
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('disconnected');
    expect(res.body.status).toBe('degraded');
  });
});