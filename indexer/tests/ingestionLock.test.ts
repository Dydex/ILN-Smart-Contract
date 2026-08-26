import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers.js';
import { createIngestionLock } from '../src/ingestion/ingestionLock.js';

describe('ingestion leader election', () => {
  it('allows only one instance to hold the lock at a time', () => {
    const db = createTestDb();
    let now = 1_000_000;
    const clock = () => now;

    const a = createIngestionLock({
      db,
      instanceId: 'instance-a',
      leaseMs: 10_000,
      clock,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const b = createIngestionLock({
      db,
      instanceId: 'instance-b',
      leaseMs: 10_000,
      clock,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(a.tryAcquire()).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(b.isLeader()).toBe(false);

    expect(a.heartbeat()).toBe(true);
    expect(b.tryAcquire()).toBe(false);

    // Expire the lease — B can take over.
    now += 20_000;
    expect(a.isLeader()).toBe(false);
    expect(b.tryAcquire()).toBe(true);
    expect(b.isLeader()).toBe(true);
    expect(a.tryAcquire()).toBe(false);
  });

  it('releases the lock so a standby can become leader', () => {
    const db = createTestDb();
    const a = createIngestionLock({
      db,
      instanceId: 'writer-1',
      leaseMs: 30_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const b = createIngestionLock({
      db,
      instanceId: 'writer-2',
      leaseMs: 30_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(b.tryAcquire()).toBe(true);
    expect(b.isLeader()).toBe(true);
  });

  it('runAsLeader stops the writer when the lease is lost', async () => {
    const db = createTestDb();
    let now = 5_000;
    const clock = () => now;
    const leader = createIngestionLock({
      db,
      instanceId: 'leader',
      leaseMs: 1_000,
      heartbeatMs: 50,
      clock,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const started = vi.fn();
    const stopped = vi.fn();
    const outer = new AbortController();

    const runPromise = leader.runAsLeader(async (signal) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          stopped();
          resolve();
        });
      });
    }, outer.signal);

    // Wait until leadership starts, then expire without renewing via clock jump
    // larger than lease + heartbeat grace, and let the heartbeat interval fire.
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    now += 50_000;
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled(), { timeout: 3_000 });
    outer.abort();
    await runPromise;
  });
});
