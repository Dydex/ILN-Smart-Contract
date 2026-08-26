import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from './helpers.js';

describe('indexer access control', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unknown API key', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      apiKeys: ['known-client-key'],
      health: { horizonUrl: '', getChainTipLedger: async () => null },
    });

    const res = await request(app)
      .get('/leaderboard')
      .set('X-API-Key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('accepts a known API key on public routes', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      apiKeys: ['known-client-key'],
      rateLimitAnonymousMax: 2,
      rateLimitApiKeyMax: 20,
      health: { horizonUrl: '', getChainTipLedger: async () => null },
    });

    const res = await request(app)
      .get('/leaderboard')
      .set('X-API-Key', 'known-client-key');

    expect(res.status).toBe(200);
  });

  it('does not rate-limit /health so monitors stay reliable', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      rateLimitAnonymousMax: 2,
      rateLimitApiKeyMax: 2,
      rateLimitWindowMs: 60_000,
      health: { horizonUrl: '', getChainTipLedger: async () => 100 },
    });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    }
  });
});
