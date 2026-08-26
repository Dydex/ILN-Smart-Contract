import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';

const LAST_LEDGER_STATE_KEY = 'last_processed_ledger';
const LAST_CURSOR_STATE_KEY = 'last_processed_cursor';
const INGESTION_LEADER_KEY = 'ingestion_leader';

export interface HealthCheckDeps {
  horizonUrl?: string;
  /** Ledger lag above this threshold marks the service degraded. */
  maxLagLedgers?: number;
  fetchImpl?: typeof fetch;
  /** Optional override for tests — returns the current chain tip ledger. */
  getChainTipLedger?: () => Promise<number | null>;
  /** Process-local ingestion flag (defaults to config/env). */
  ingestionEnabled?: boolean;
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  db: 'connected' | 'disconnected';
  horizon: 'connected' | 'disconnected' | 'unknown';
  ingestion: {
    enabled: boolean;
    isLeader: boolean | null;
    lastLedger: number | null;
    lastCursor: string | null;
    lagLedgers: number | null;
  };
  lastEventAt: string | null;
  checkedAt: string;
}

export function createHealthRouter(
  db: Database.Database,
  deps: HealthCheckDeps = {}
): Router {
  const router = Router();
  const maxLagLedgers = deps.maxLagLedgers ?? 50;
  const horizonUrl = (deps.horizonUrl ?? '').replace(/\/$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;

  router.get('/health', async (_req: Request, res: Response) => {
    const checkedAt = new Date().toISOString();
    let dbOk = false;
    let lastLedger: number | null = null;
    let lastCursor: string | null = null;
    let lastEventAt: string | null = null;
    let isLeader: boolean | null = null;

    try {
      db.prepare('SELECT 1').get();
      dbOk = true;

      const ledgerRow = db
        .prepare('SELECT state_value FROM indexer_state WHERE state_key = ?')
        .get(LAST_LEDGER_STATE_KEY) as { state_value: string } | undefined;
      const cursorRow = db
        .prepare('SELECT state_value FROM indexer_state WHERE state_key = ?')
        .get(LAST_CURSOR_STATE_KEY) as { state_value: string } | undefined;
      const leaderRow = db
        .prepare('SELECT state_value FROM indexer_state WHERE state_key = ?')
        .get(INGESTION_LEADER_KEY) as { state_value: string } | undefined;

      if (ledgerRow?.state_value) {
        const parsed = Number(ledgerRow.state_value);
        lastLedger = Number.isFinite(parsed) ? parsed : null;
      }
      lastCursor = cursorRow?.state_value ?? null;

      if (leaderRow?.state_value) {
        try {
          const leader = JSON.parse(leaderRow.state_value) as {
            instanceId?: string;
            expiresAt?: number;
          };
          isLeader =
            typeof leader.expiresAt === 'number' && leader.expiresAt > Date.now();
        } catch {
          isLeader = false;
        }
      }

      const lastEvent = db
        .prepare('SELECT MAX(timestamp) AS ts FROM events')
        .get() as { ts: number | null } | undefined;
      if (lastEvent?.ts) {
        lastEventAt = new Date(lastEvent.ts * 1000).toISOString();
      }
    } catch {
      dbOk = false;
    }

    let horizonStatus: HealthPayload['horizon'] = 'unknown';
    let chainTip: number | null = null;

    try {
      if (deps.getChainTipLedger) {
        chainTip = await deps.getChainTipLedger();
        horizonStatus = chainTip !== null ? 'connected' : 'disconnected';
      } else if (horizonUrl) {
        const response = await fetchImpl(`${horizonUrl}/`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            core_latest_ledger?: number;
            history_latest_ledger?: number;
          };
          chainTip =
            body.core_latest_ledger ?? body.history_latest_ledger ?? null;
          horizonStatus = 'connected';
        } else {
          horizonStatus = 'disconnected';
        }
      }
    } catch {
      horizonStatus = 'disconnected';
    }

    const lagLedgers =
      chainTip !== null && lastLedger !== null
        ? Math.max(0, chainTip - lastLedger)
        : null;

    const lagHealthy = lagLedgers === null || lagLedgers <= maxLagLedgers;
    const isHealthy = dbOk && horizonStatus !== 'disconnected' && lagHealthy;

    const ingestionEnabled =
      deps.ingestionEnabled ??
      parseIngestionEnabled(process.env.INGESTION_ENABLED, true);

    const payload: HealthPayload = {
      status: isHealthy ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'disconnected',
      horizon: horizonStatus,
      ingestion: {
        enabled: ingestionEnabled,
        isLeader,
        lastLedger,
        lastCursor,
        lagLedgers,
      },
      lastEventAt,
      checkedAt,
    };

    res.status(isHealthy ? 200 : 503).json(payload);
  });

  return router;
}

function parseIngestionEnabled(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}
