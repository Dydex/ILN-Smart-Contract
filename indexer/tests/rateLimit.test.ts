import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from './helpers.js';

const publicPaths = [
  { name: 'leaderboard', method: 'get' as const, path: '/leaderboard' },
  { name: 'stats', method: 'get' as const, path: '/stats' },
  { name: 'invoices', method: 'get' as const, path: '/invoices' },
  {
    name: 'graphql',
    method: 'post' as const,
    path: '/graphql',
    body: { query: '{ __typename }' },
  },
];

describe('indexer rate-limit coverage', () => {
  for (const route of publicPaths) {
    it(`rate-limits anonymous traffic on ${route.name} under load`, async () => {
      const db = createTestDb();
      const app = createTestApp(db, {
        rateLimitAnonymousMax: 5,
        rateLimitApiKeyMax: 50,
        rateLimitWindowMs: 60_000,
        health: {
          horizonUrl: '',
          getChainTipLedger: async () => null,
        },
      });

      for (let i = 0; i < 5; i += 1) {
        const res =
          route.method === 'post'
            ? await request(app).post(route.path).send(route.body)
            : await request(app).get(route.path);
        expect(res.status).not.toBe(429);
      }

      const limited =
        route.method === 'post'
          ? await request(app).post(route.path).send(route.body)
          : await request(app).get(route.path);

      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body.error).toContain('Too many requests');
    });
  }

  it('does not rate-limit /health after public routes are exhausted', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      rateLimitAnonymousMax: 2,
      rateLimitApiKeyMax: 50,
      rateLimitWindowMs: 60_000,
      health: {
        horizonUrl: '',
        getChainTipLedger: async () => 1,
      },
    });

    expect((await request(app).get('/leaderboard')).status).toBe(200);
    expect((await request(app).get('/leaderboard')).status).toBe(200);
    expect((await request(app).get('/leaderboard')).status).toBe(429);

    const health = await request(app).get('/health');
    expect([200, 503]).toContain(health.status);
    expect(health.status).not.toBe(429);
  });

  it('gives API-key traffic a higher limit without unlimited bypass', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      apiKeys: ['prod-client-key'],
      rateLimitAnonymousMax: 3,
      rateLimitApiKeyMax: 8,
      rateLimitWindowMs: 60_000,
      health: {
        horizonUrl: '',
        getChainTipLedger: async () => null,
      },
    });

    for (let i = 0; i < 8; i += 1) {
      const res = await request(app)
        .get('/leaderboard')
        .set('X-API-Key', 'prod-client-key');
      expect(res.status).toBe(200);
    }

    const limited = await request(app)
      .get('/leaderboard')
      .set('X-API-Key', 'prod-client-key');
    expect(limited.status).toBe(429);

    const anonApp = createTestApp(createTestDb(), {
      apiKeys: ['prod-client-key'],
      rateLimitAnonymousMax: 3,
      rateLimitApiKeyMax: 8,
      rateLimitWindowMs: 60_000,
      health: { horizonUrl: '', getChainTipLedger: async () => null },
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(anonApp).get('/stats')).status).toBe(200);
    }
    expect((await request(anonApp).get('/stats')).status).toBe(429);
  });
});
