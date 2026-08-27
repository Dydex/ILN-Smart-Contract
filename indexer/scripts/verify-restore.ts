/**
 * Post-restore verification script.
 *
 * Boots the real indexer API (express app) against a restored database file
 * and exercises the public read endpoints to confirm they return correct
 * data after a backup/restore cycle.
 *
 * Usage:
 *   tsx indexer/scripts/verify-restore.ts --db ./restored/indexer.db
 *
 * Exits non-zero if any endpoint fails or returns structurally invalid data.
 */

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { clearStatsCache } from '../src/services/statsService.js';

interface VerifyOptions {
  dbPath: string;
}

function parseArgs(argv: string[]): VerifyOptions {
  let dbPath = process.env.DB_PATH || './restored/indexer.db';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') {
      i += 1;
      dbPath = argv[i] || dbPath;
    }
  }
  return { dbPath };
}

async function startApi(db: Database.Database): Promise<{
  close: () => Promise<void>;
  get: (path: string) => Promise<{ status: number; body: any }>;
}> {
  clearStatsCache();
  const app = createApp(db);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const agent = request(`http://127.0.0.1:${port}`);
  return {
    close: () => new Promise<void>((cb) => server.close(() => cb())),
    get: async (path: string) => {
      const res = await agent.get(path);
      return { status: res.status, body: res.body };
    },
  };
}

export async function verifyRestoredDatabase(options: VerifyOptions): Promise<boolean> {
  const { dbPath } = options;
  console.log(`Verifying restored database: ${dbPath}`);

  try {
    await fs.access(dbPath);
  } catch {
    console.error(`FAIL: database file not found at ${dbPath}`);
    return false;
  }

  const db = new Database(dbPath);
  const api = await startApi(new Database(dbPath));
  const failures: string[] = [];

  try {
    // 1. Health endpoint must be up.
    const health = await api.get('/health');
    if (health.status !== 200 || health.body.status !== 'ok') {
      failures.push(`/health returned ${health.status}: ${JSON.stringify(health.body)}`);
    } else {
      console.log('PASS /health');
    }

    // 2. Stats endpoint must reflect restored rows.
    const stats = await api.get('/stats');
    if (stats.status !== 200 || typeof stats.body.totalInvoices !== 'number') {
      failures.push(`/stats returned ${stats.status}: ${JSON.stringify(stats.body)}`);
    } else {
      const expectedTotal = (
        db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as { n: number }
      ).n;
      if (stats.body.totalInvoices !== expectedTotal) {
        failures.push(
          `/stats totalInvoices (${stats.body.totalInvoices}) != invoices table count (${expectedTotal})`
        );
      } else {
        console.log(`PASS /stats (totalInvoices=${stats.body.totalInvoices})`);
      }
    }

    // 3. Every invoice in the restored DB must be served correctly by id.
    const invoiceIds = db.prepare(`SELECT id FROM invoices ORDER BY id LIMIT 25`).all() as Array<{
      id: number;
    }>;
    for (const { id } of invoiceIds) {
      const res = await api.get(`/invoices/${id}`);
      if (res.status !== 200 || res.body.id !== id) {
        failures.push(`/invoices/${id} returned ${res.status}`);
        continue;
      }
      const row = db
        .prepare(`SELECT status, amount FROM invoices WHERE id = ?`)
        .get(id) as { status: string; amount: string };
      if (res.body.status !== row.status || res.body.amount !== row.amount) {
        failures.push(`/invoices/${id} body does not match restored row`);
        continue;
      }
      const eventCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM events WHERE invoice_id = ?`).get(id) as { n: number }
      ).n;
      if ((res.body.events?.length ?? 0) !== eventCount) {
        failures.push(
          `/invoices/${id} events length ${res.body.events?.length} != events table count ${eventCount}`
        );
      }
    }
    if (invoiceIds.length > 0 && failures.length === 0) {
      console.log(`PASS /invoices/:id (${invoiceIds.length} sampled invoices match restored rows)`);
    }

    // 4. Events listing endpoint (requires a known participant address).
    const firstParticipant = (
      db
        .prepare(`SELECT freelancer FROM invoices ORDER BY id LIMIT 1`)
        .get() as { freelancer: string } | undefined
    )?.freelancer;
    if (firstParticipant) {
      const events = await api.get(`/events?address=${encodeURIComponent(firstParticipant)}&pageSize=5`);
      const payload = Array.isArray(events.body) ? events.body : events.body?.events;
      if (events.status !== 200 || !Array.isArray(payload)) {
        failures.push(`/events returned ${events.status}: ${JSON.stringify(events.body).slice(0, 200)}`);
      } else {
        console.log(`PASS /events (${payload.length} event(s) for ${firstParticipant.slice(0, 8)}...)`);
      }
    }

    // 5. Leaderboard and reputation endpoints respond with valid shapes.
    const leaderboard = await api.get('/leaderboard?limit=5');
    if (leaderboard.status !== 200) {
      failures.push(`/leaderboard returned ${leaderboard.status}`);
    } else {
      console.log('PASS /leaderboard');
    }

    const firstAddress = (
      db.prepare(`SELECT address FROM reputation_updates ORDER BY timestamp DESC LIMIT 1`).get() as
        | { address: string }
        | undefined
    )?.address;
    if (firstAddress) {
      const reputation = await api.get(`/reputation/${encodeURIComponent(firstAddress)}`);
      if (reputation.status !== 200) {
        failures.push(`/reputation/${firstAddress} returned ${reputation.status}`);
      } else {
        console.log(`PASS /reputation/${firstAddress.slice(0, 8)}...`);
      }
    }
  } finally {
    await api.close();
    db.close();
  }

  if (failures.length > 0) {
    console.error(`VERIFY FAILED with ${failures.length} problem(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    return false;
  }

  console.log('VERIFY PASSED: restored database serves correct data through all checked endpoints.');
  return true;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('verify-restore.ts');
if (invokedDirectly) {
  verifyRestoredDatabase(parseArgs(process.argv.slice(2)))
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`Verification crashed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
