import express from 'express';
import type Database from 'better-sqlite3';
import { createLeaderboardRouter } from './api/routes/leaderboard.js';
import { createReputationRouter } from './api/routes/reputation.js';
import { createStatsRouter } from './api/routes/stats.js';
import { createInvoicesRouter } from './api/routes/invoices.js';
import { config } from './config.js';
import { createApiKeyMiddleware } from './middleware/apiKey.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { createEventsRouter } from './api/routes/events.js';
import { createHealthRouter, type HealthCheckDeps } from './api/routes/health.js';
import { mountGraphQL } from './api/graphql/index.js';

export interface CreateAppOptions {
  apiKeys?: string[];
  /** @deprecated Prefer rateLimitAnonymousMax / rateLimitApiKeyMax. */
  rateLimitMax?: number;
  rateLimitAnonymousMax?: number;
  rateLimitApiKeyMax?: number;
  rateLimitWindowMs?: number;
  graphqlMaxDepth?: number;
  graphqlMaxComplexity?: number;
  health?: HealthCheckDeps;
}

export function createApp(
  db: Database.Database,
  options: CreateAppOptions = {}
): express.Express {
  const app = express();
  const apiKeys = options.apiKeys ?? config.apiKeys;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? config.rateLimitWindowMs;
  const rateLimitAnonymousMax =
    options.rateLimitAnonymousMax ??
    options.rateLimitMax ??
    config.rateLimitAnonymousMax;
  const rateLimitApiKeyMax =
    options.rateLimitApiKeyMax ??
    (options.rateLimitMax !== undefined
      ? options.rateLimitMax * 10
      : config.rateLimitApiKeyMax);

  app.use(express.json());
  // API key auth must run before rate limiting so authenticated traffic gets
  // the higher tier and is keyed by API key rather than IP.
  app.use(createApiKeyMiddleware(apiKeys));
  app.use(
    createRateLimitMiddleware({
      anonymousLimit: rateLimitAnonymousMax,
      apiKeyLimit: rateLimitApiKeyMax,
      windowMs: rateLimitWindowMs,
      skipPaths: ['/health'],
    })
  );

  // Health is registered early and is excluded from rate limiting so external
  // uptime checks are not throttled. Rate-limit middleware still runs first
  // but skips /health via skipPaths.
  const healthDeps: HealthCheckDeps = {
    horizonUrl: options.health?.horizonUrl ?? config.horizonUrl,
    maxLagLedgers: options.health?.maxLagLedgers ?? config.healthMaxLagLedgers,
    ingestionEnabled:
      options.health?.ingestionEnabled ?? config.ingestionEnabled,
  };
  if (options.health?.fetchImpl) {
    healthDeps.fetchImpl = options.health.fetchImpl;
  }
  if (options.health?.getChainTipLedger) {
    healthDeps.getChainTipLedger = options.health.getChainTipLedger;
  }
  app.use(createHealthRouter(db, healthDeps));

  app.use(createLeaderboardRouter(db));
  app.use(createReputationRouter(db));
  app.use(createStatsRouter(db));
  app.use(createInvoicesRouter(db));
  app.use(createEventsRouter(db));
  mountGraphQL(app, db, {
    maxDepth: options.graphqlMaxDepth ?? config.graphqlMaxDepth,
    maxComplexity: options.graphqlMaxComplexity ?? config.graphqlMaxComplexity,
  });

  return app;
}
