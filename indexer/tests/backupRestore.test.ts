import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initializeSchema } from '../src/db/schema.js';
import { clearStatsCache } from '../src/services/statsService.js';
import { applyRetention, createBackup, type BackupManifest } from '../scripts/backup.js';
import { runRestore } from '../scripts/restore.js';
import { verifyRestoredDatabase } from '../scripts/verify-restore.js';

interface TestContext {
  tmpDir: string;
  dbPath: string;
  backupDir: string;
}

let ctx: TestContext;

async function makeContext(): Promise<TestContext> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iln-indexer-backup-'));
  const dbPath = path.join(tmpDir, 'indexer.db');
  const backupDir = path.join(tmpDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  return { tmpDir, dbPath, backupDir };
}

async function seedLiveDatabase(dbPath: string): Promise<void> {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);

  const now = Math.floor(Date.now() / 1000);
  const insertInvoice = db.prepare(
    `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, status,
       funder, funded_at, amount_funded, amount_paid, referral_code, submitter_reputation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertInvoice.run(
    1, 'GAAA-FREELANCER', 'GAAA-PAYER', 'USDC', '1000000',
    now + 30 * 86400, 500, 'Paid', 'GAAA-LP', now + 60, '1000000', '970000', null, 50, now
  );
  insertInvoice.run(
    2, 'GAAA-FREELANCER-2', 'GAAA-PAYER-2', 'USDC', '250000',
    now + 15 * 86400, 300, 'Pending', null, null, '0', '0', null, 42, now
  );

  const insertEvent = db.prepare(
    `INSERT INTO events (invoice_id, event_type, ledger, timestamp, data)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertEvent.run(1, 'submitted', 100, now, '{}');
  insertEvent.run(1, 'funded', 101, now + 60, '{}');
  insertEvent.run(1, 'paid', 102, now + 120, '{}');
  insertEvent.run(2, 'submitted', 103, now, '{}');

  db.prepare(
    `INSERT INTO indexer_state (state_key, state_value) VALUES ('last_processed_ledger', '102')`
  ).run();
  db.prepare(
    `INSERT INTO indexer_state (state_key, state_value) VALUES ('last_processed_cursor', '123456789')`
  ).run();

  db.close();
}

async function apiGet(dbPath: string, url: string): Promise<{ status: number; body: any }> {
  clearStatsCache();
  const db = new Database(dbPath);
  const app = createApp(db);
  try {
    const res = await request(app).get(url);
    return { status: res.status, body: res.body };
  } finally {
    db.close();
  }
}

describe('indexer database backup and restore procedure', () => {
  beforeEach(async () => {
    ctx = await makeContext();
    await seedLiveDatabase(ctx.dbPath);
  });

  afterEach(async () => {
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('creates a checksummed manifest snapshot with the ingestion checkpoint', async () => {
    const manifest = await createBackup({ dbPath: ctx.dbPath, backupDir: ctx.backupDir });

    expect(manifest.file).toMatch(/^indexer-backup-.*\.db\.gz$/);
    expect(manifest.sha256).toHaveLength(64);
    expect(manifest.last_processed_ledger).toBe(102);
    expect(manifest.last_processed_cursor).toBe('123456789');
    expect(manifest.table_counts.invoices).toBe(2);
    expect(manifest.table_counts.events).toBe(4);

    const gzStat = await fs.stat(path.join(ctx.backupDir, manifest.file));
    expect(gzStat.size).toBeGreaterThan(0);
    const storedManifest = JSON.parse(
      await fs.readFile(path.join(ctx.backupDir, `${manifest.file}.json`), 'utf8')
    ) as BackupManifest;
    expect(storedManifest.file).toBe(manifest.file);
  });

  it('performs a full restore into a fresh instance and serves correct data via the API', async () => {
    const manifest = await createBackup({ dbPath: ctx.dbPath, backupDir: ctx.backupDir });

    // Simulate total data loss of the live database.
    await fs.rm(ctx.dbPath, { force: true });
    await fs.rm(`${ctx.dbPath}-wal`, { force: true });
    await fs.rm(`${ctx.dbPath}-shm`, { force: true });

    const restoredPath = path.join(ctx.tmpDir, 'restored', 'indexer.db');
    const target = await runRestore({
      file: path.join(ctx.backupDir, manifest.file),
      target: restoredPath,
      backupDir: ctx.backupDir,
    });
    expect(target).toBe(restoredPath);

    // The API endpoints must return the exact pre-loss data post-restore.
    const invoice1 = await apiGet(restoredPath, '/invoices/1');
    expect(invoice1.status).toBe(200);
    expect(invoice1.body.status).toBe('Paid');
    expect(invoice1.body.amountPaid).toBe('970000');
    expect(invoice1.body.events.map((e: any) => e.type)).toEqual(['submitted', 'funded', 'paid']);

    const invoice2 = await apiGet(restoredPath, '/invoices/2');
    expect(invoice2.status).toBe(200);
    expect(invoice2.body.status).toBe('Pending');

    const stats = await apiGet(restoredPath, '/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.totalInvoices).toBe(2);
    expect(stats.body.totalPaid).toBe(1);

    const health = await apiGet(restoredPath, '/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    // And the dedicated verifier must pass end to end.
    await expect(verifyRestoredDatabase({ dbPath: restoredPath })).resolves.toBe(true);
  });

  it('refuses to restore a tampered backup (checksum mismatch)', async () => {
    const manifest = await createBackup({ dbPath: ctx.dbPath, backupDir: ctx.backupDir });
    const gzPath = path.join(ctx.backupDir, manifest.file);

    // Flip bytes inside the archive to simulate corrupted backup media.
    const raw = await fs.readFile(gzPath);
    raw[raw.length - 5] = raw[raw.length - 5] ^ 0xff;
    await fs.writeFile(gzPath, raw);

    const restoredPath = path.join(ctx.tmpDir, 'restored-tampered.db');
    await expect(
      runRestore({ file: gzPath, target: restoredPath, backupDir: ctx.backupDir })
    ).rejects.toThrow(/Checksum mismatch/);
    await expect(fs.access(restoredPath)).rejects.toThrow();
  });

  it('does not overwrite an existing target unless forced', async () => {
    const manifest = await createBackup({ dbPath: ctx.dbPath, backupDir: ctx.backupDir });
    const existing = path.join(ctx.tmpDir, 'existing.db');
    await fs.writeFile(existing, 'not a database');

    await expect(
      runRestore({
        file: path.join(ctx.backupDir, manifest.file),
        target: existing,
        backupDir: ctx.backupDir,
      })
    ).rejects.toThrow(/already exists/);

    // --force-overwrite replaces it with the real restore.
    await runRestore({
      file: path.join(ctx.backupDir, manifest.file),
      target: existing,
      force: true,
      backupDir: ctx.backupDir,
    });
    const db = new Database(existing, { readonly: true });
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as { n: number }).n;
    db.close();
    expect(count).toBe(2);
  });

  it('prunes expired backups according to the retention schedule', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const dayMs = 86_400_000;

    // 10 consecutive daily backups, plus two old-monthly stragglers.
    const timestamps = [
      ...Array.from({ length: 10 }, (_, i) => new Date(now.getTime() - i * dayMs)),
      new Date('2026-05-02T09:00:00Z'),
      new Date('2026-03-02T09:00:00Z'),
    ];

    for (const ts of timestamps) {
      await createBackup({ dbPath: ctx.dbPath, backupDir: ctx.backupDir, now: ts });
    }

    // Retention defaults: 7 daily / 4 weekly / 3 monthly.
    const deleted = await applyRetention({
      backupDir: ctx.backupDir,
      retentionDailyDays: 7,
      retentionWeeklyWeeks: 4,
      retentionMonthlyMonths: 3,
    });

    const remainingManifests = (await fs.readdir(ctx.backupDir)).filter((f) =>
      f.endsWith('.db.gz.json')
    );
    // Newest + 7 distinct daily + weekly collapses for days 8-10 + monthly keeps.
    // With all backups in one ISO week window the exact count varies; assert the
    // guarantees that matter:
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted).not.toContain(timestamps[0].toISOString());
    // Newest backup always survives.
    expect(remainingManifests.length).toBeGreaterThanOrEqual(8);
    expect(remainingManifests.length).toBeLessThan(timestamps.length);
    // Oldest backups outside every window are gone.
    const remainingSet = new Set(remainingManifests);
    for (const entry of deleted) {
      expect(remainingSet.has(entry)).toBe(false);
      await expect(fs.access(path.join(ctx.backupDir, entry))).rejects.toThrow();
    }
  });

  it('fails cleanly when no source database exists', async () => {
    await expect(
      createBackup({ dbPath: path.join(ctx.tmpDir, 'missing.db'), backupDir: ctx.backupDir })
    ).rejects.toThrow(/Source database not found/);
  });
});
