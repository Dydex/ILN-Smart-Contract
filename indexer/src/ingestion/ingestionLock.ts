import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const LOCK_KEY = 'ingestion_leader';
const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export interface IngestionLockOptions {
  db: Database.Database;
  /** Unique id for this process. Defaults to a random UUID. */
  instanceId?: string;
  /** How long a lease is valid without heartbeat. */
  leaseMs?: number;
  /** How often the leader renews the lease. */
  heartbeatMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  clock?: () => number;
}

export interface IngestionLockHandle {
  readonly instanceId: string;
  /** Attempt to become (or remain) the ingestion leader. */
  tryAcquire(): boolean;
  /** Whether this instance currently holds a valid lease. */
  isLeader(): boolean;
  /** Renew the lease if this instance is the holder. */
  heartbeat(): boolean;
  /** Release the lease if held by this instance. */
  release(): void;
  /**
   * Run `fn` only while this instance holds the lock.
   * Contenders poll until they acquire leadership or `signal` aborts.
   */
  runAsLeader(fn: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void>;
}

interface LockPayload {
  instanceId: string;
  expiresAt: number;
}

/**
 * SQLite lease-based leader election for the ingestion writer.
 *
 * Only one process should run Horizon event ingestion against a shared DB.
 * Read-only API replicas can run with `INGESTION_ENABLED=false` and skip this
 * entirely. When multiple writer candidates share a DB file, this lock ensures
 * a single active ingestor without duplicate event processing.
 *
 * Mechanism: a row in `indexer_state` stores `{ instanceId, expiresAt }`.
 * Acquisition uses a compare-and-swap update inside an immediate transaction.
 */
export function createIngestionLock(options: IngestionLockOptions): IngestionLockHandle {
  const db = options.db;
  const instanceId = options.instanceId ?? randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const logger = options.logger ?? console;
  const now = options.clock ?? Date.now;

  const readLock = db.prepare(
    'SELECT state_value FROM indexer_state WHERE state_key = ?'
  );
  const upsertLock = db.prepare(`
    INSERT INTO indexer_state (state_key, state_value)
    VALUES (?, ?)
    ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value
  `);
  const deleteLock = db.prepare(
    'DELETE FROM indexer_state WHERE state_key = ? AND state_value LIKE ?'
  );

  function parsePayload(raw: string | undefined): LockPayload | null {
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as LockPayload;
      if (
        typeof parsed.instanceId === 'string' &&
        typeof parsed.expiresAt === 'number'
      ) {
        return parsed;
      }
    } catch {
      // Corrupt lock row — treat as free.
    }
    return null;
  }

  function currentPayload(): LockPayload | null {
    const row = readLock.get(LOCK_KEY) as { state_value: string } | undefined;
    return parsePayload(row?.state_value);
  }

  function writeLease(expiresAt: number): void {
    const payload: LockPayload = { instanceId, expiresAt };
    upsertLock.run(LOCK_KEY, JSON.stringify(payload));
  }

  function tryAcquire(): boolean {
    const acquire = db.transaction(() => {
      const existing = currentPayload();
      const ts = now();

      if (
        existing &&
        existing.expiresAt > ts &&
        existing.instanceId !== instanceId
      ) {
        return false;
      }

      writeLease(ts + leaseMs);
      return true;
    });

    return acquire();
  }

  function isLeader(): boolean {
    const existing = currentPayload();
    const ts = now();
    return Boolean(
      existing &&
        existing.instanceId === instanceId &&
        existing.expiresAt > ts
    );
  }

  function heartbeat(): boolean {
    const renew = db.transaction(() => {
      const existing = currentPayload();
      const ts = now();
      if (!existing || existing.instanceId !== instanceId) {
        return false;
      }
      // Allow renewal slightly past expiry to absorb scheduling jitter.
      if (existing.expiresAt + heartbeatMs < ts) {
        return false;
      }
      writeLease(ts + leaseMs);
      return true;
    });
    return renew();
  }

  function release(): void {
    deleteLock.run(LOCK_KEY, `%"instanceId":"${instanceId}"%`);
  }

  async function runAsLeader(
    fn: (signal: AbortSignal) => Promise<void>,
    outerSignal?: AbortSignal
  ): Promise<void> {
    const pollMs = Math.max(500, Math.floor(heartbeatMs / 2));

    while (!outerSignal?.aborted) {
      if (!tryAcquire()) {
        await sleep(pollMs, outerSignal);
        continue;
      }

      logger.info(`ingestion leader acquired by ${instanceId}`);
      const leaderAbort = new AbortController();
      const onOuterAbort = () => leaderAbort.abort();
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

      const heartbeatTimer = setInterval(() => {
        if (!heartbeat()) {
          logger.warn(`ingestion leader lost lease (${instanceId}); stopping writer`);
          leaderAbort.abort();
        }
      }, heartbeatMs);

      try {
        await fn(leaderAbort.signal);
      } finally {
        clearInterval(heartbeatTimer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
        release();
        logger.info(`ingestion leader released by ${instanceId}`);
      }

      if (outerSignal?.aborted) {
        break;
      }

      // Brief pause before re-contending after an unexpected lease loss.
      await sleep(pollMs, outerSignal);
    }
  }

  return {
    instanceId,
    tryAcquire,
    isLeader,
    heartbeat,
    release,
    runAsLeader,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
