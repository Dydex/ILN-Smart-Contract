/**
 * Indexer database backup script.
 *
 * Creates a consistent, gzip-compressed snapshot of the SQLite database using
 * better-sqlite3's online backup API (safe to run against a live WAL-mode
 * database without stopping the indexer). Each backup is accompanied by a
 * manifest containing a SHA-256 checksum and the ingestion checkpoint that
 * was active at snapshot time.
 *
 * Retention (grandfather-father-son), configurable via env or options:
 *   - RETENTION_DAILY_DAYS     keep the newest backup per day for N days   (default 7)
 *   - RETENTION_WEEKLY_WEEKS   keep the newest backup per week for W weeks (default 4)
 *   - RETENTION_MONTHLY_MONTHS keep the newest per month for M months    (default 3)
 *
 * Usage:
 *   tsx indexer/scripts/backup.ts
 *   DB_PATH=./indexer.db BACKUP_DIR=/var/backups/iln-indexer npm run --prefix indexer backup
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface BackupManifest {
  file: string;
  sha256: string;
  sizeBytes: number;
  created_at: string;
  source_db_path: string;
  last_processed_ledger: number | null;
  last_processed_cursor: string | null;
  table_counts: Record<string, number>;
}

export interface BackupOptions {
  dbPath?: string;
  backupDir?: string;
  retentionDailyDays?: number;
  retentionWeeklyWeeks?: number;
  retentionMonthlyMonths?: number;
  now?: Date;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function gzipFile(sourcePath: string, targetPath: string): Promise<void> {
  const { pipeline } = await import('node:stream/promises');
  const { createGzip } = await import('node:zlib');
  await pipeline(createReadStream(sourcePath), createGzip(), createWriteStream(targetPath));
}

export async function createBackup(options: BackupOptions = {}): Promise<BackupManifest> {
  const dbPath = options.dbPath ?? (process.env.DB_PATH || './indexer.db');
  const backupDir = options.backupDir ?? (process.env.BACKUP_DIR || './backups');
  const retentionDailyDays = options.retentionDailyDays ?? parseInt(process.env.RETENTION_DAILY_DAYS || '7', 10);
  const retentionWeeklyWeeks = options.retentionWeeklyWeeks ?? parseInt(process.env.RETENTION_WEEKLY_WEEKS || '4', 10);
  const retentionMonthlyMonths =
    options.retentionMonthlyMonths ?? parseInt(process.env.RETENTION_MONTHLY_MONTHS || '3', 10);
  const createdAt = options.now ?? new Date();

  await fs.mkdir(backupDir, { recursive: true });

  if (!(await fileExists(dbPath))) {
    throw new Error(`Source database not found at ${dbPath}. Set DB_PATH or run the indexer first.`);
  }

  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const tmpSnapshot = path.join(backupDir, `.tmp-snapshot-${stamp}`);
  const gzTarget = path.join(backupDir, `indexer-backup-${stamp}.db.gz`);
  const manifestPath = `${gzTarget}.json`;

  // Online backup API: produces a transactionally consistent snapshot even
  // while the live indexer holds write transactions on the source database.
  const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(tmpSnapshot);
  } finally {
    sourceDb.close();
  }

  const snapshotDb = new Database(tmpSnapshot, { readonly: true });
  let tableCounts: Record<string, number>;
  let lastLedger: number | null;
  let lastCursor: string | null;
  try {
    const counts = snapshotDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    tableCounts = {};
    for (const { name } of counts) {
      tableCounts[name] = (snapshotDb.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    }
    const ledgerRow = snapshotDb
      .prepare(`SELECT state_value FROM indexer_state WHERE state_key = 'last_processed_ledger'`)
      .get() as { state_value: string } | undefined;
    lastLedger = ledgerRow ? Number(ledgerRow.state_value) : null;
    const cursorRow = snapshotDb
      .prepare(`SELECT state_value FROM indexer_state WHERE state_key = 'last_processed_cursor'`)
      .get() as { state_value: string } | undefined;
    lastCursor = cursorRow ? cursorRow.state_value : null;
  } finally {
    snapshotDb.close();
  }

  await gzipFile(tmpSnapshot, gzTarget);
  await fs.unlink(tmpSnapshot);

  const manifest: BackupManifest = {
    file: path.basename(gzTarget),
    sha256: await sha256File(gzTarget),
    sizeBytes: (await fs.stat(gzTarget)).size,
    created_at: createdAt.toISOString(),
    source_db_path: path.resolve(dbPath),
    last_processed_ledger: lastLedger,
    last_processed_cursor: lastCursor,
    table_counts: tableCounts,
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return manifest;
}

/**
 * Grandfather-father-son retention. Backups newer than the daily window are
 * collapsed to the newest per day; older ones collapse further to newest per
 * ISO week and then per calendar month. The most recent backup is always kept.
 */
export async function applyRetention(options: BackupOptions = {}): Promise<string[]> {
  const backupDir = options.backupDir ?? (process.env.BACKUP_DIR || './backups');
  const retentionDailyDays = options.retentionDailyDays ?? parseInt(process.env.RETENTION_DAILY_DAYS || '7', 10);
  const retentionWeeklyWeeks = options.retentionWeeklyWeeks ?? parseInt(process.env.RETENTION_WEEKLY_WEEKS || '4', 10);
  const retentionMonthlyMonths =
    options.retentionMonthlyMonths ?? parseInt(process.env.RETENTION_MONTHLY_MONTHS || '3', 10);

  const entries = await listBackups(backupDir);
  if (entries.length === 0) {
    return [];
  }

  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const now = entries[0].createdAt;

  const seenDays = new Set<string>();
  const seenWeeks = new Set<string>();
  const seenMonths = new Set<string>();
  const keep = new Set<string>();

  for (const entry of entries) {
    const ageDays = Math.floor((now.getTime() - entry.createdAt.getTime()) / 86_400_000);

    if (keep.size === 0) {
      keep.add(entry.manifest.file); // never prune the newest backup
      continue;
    }

    const dayKey = entry.createdAt.toISOString().slice(0, 10);
    if (ageDays < retentionDailyDays) {
      if (!seenDays.has(dayKey)) {
        seenDays.add(dayKey);
        keep.add(entry.manifest.file);
      }
      continue;
    }

    const weeksAgo = isoWeeksAgo(now, entry.createdAt);
    if (weeksAgo < retentionWeeklyWeeks) {
      const weekKey = isoWeekKey(entry.createdAt);
      if (!seenWeeks.has(weekKey)) {
        seenWeeks.add(weekKey);
        keep.add(entry.manifest.file);
      }
      continue;
    }

    const monthsAgo =
      (now.getUTCFullYear() - entry.createdAt.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - entry.createdAt.getUTCMonth());
    if (monthsAgo < retentionMonthlyMonths) {
      const monthKey = entry.createdAt.toISOString().slice(0, 7);
      if (!seenMonths.has(monthKey)) {
        seenMonths.add(monthKey);
        keep.add(entry.manifest.file);
      }
      continue;
    }
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    if (!keep.has(entry.manifest.file)) {
      await fs.rm(path.join(backupDir, entry.manifest.file), { force: true });
      await fs.rm(`${path.join(backupDir, entry.manifest.file)}.json`, { force: true });
      deleted.push(entry.manifest.file);
    }
  }
  return deleted;
}

interface BackupEntry {
  manifest: BackupManifest;
  createdAt: Date;
}

async function listBackups(backupDir: string): Promise<BackupEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(backupDir);
  } catch {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const file of files) {
    if (!file.startsWith('indexer-backup-') || !file.endsWith('.db.gz.json')) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(backupDir, file), 'utf8');
      const manifest = JSON.parse(raw) as BackupManifest;
      entries.push({ manifest, createdAt: new Date(manifest.created_at) });
    } catch {
      console.warn(`Skipping unreadable backup manifest: ${file}`);
    }
  }
  return entries;
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function isoWeeksAgo(reference: Date, target: Date): number {
  const refMonday = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  refMonday.setUTCDate(refMonday.getUTCDate() + 1 - (refMonday.getUTCDay() || 7));
  const tgtMonday = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  tgtMonday.setUTCDate(tgtMonday.getUTCDate() + 1 - (tgtMonday.getUTCDay() || 7));
  return Math.floor((refMonday.getTime() - tgtMonday.getTime()) / (7 * 86_400_000));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backup.ts');
if (invokedDirectly) {
  void (async () => {
    try {
      const manifest = await createBackup();
      console.log(`Backup created: ${path.join(process.env.BACKUP_DIR || './backups', manifest.file)}`);
      console.log(`  sha256: ${manifest.sha256}`);
      console.log(`  checkpoint ledger: ${manifest.last_processed_ledger ?? 'unknown'}`);
      console.log(`  tables: ${JSON.stringify(manifest.table_counts)}`);
      const deleted = await applyRetention();
      if (deleted.length > 0) {
        console.log(`Retention pruned ${deleted.length} expired backup(s):`);
        for (const entry of deleted) {
          console.log(`  - ${entry}`);
        }
      }
    } catch (error) {
      console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
}
