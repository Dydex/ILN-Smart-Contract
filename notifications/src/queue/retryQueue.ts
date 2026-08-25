import type Database from 'better-sqlite3';

export interface DeliveryLog {
  id: number;
  webhookId: string;
  event: string;
  invoiceId: number;
  payload: string;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

const RETRY_DELAYS_MS = [1000, 5000, 30000];
const MAX_ATTEMPTS = 3;

export class RetryQueue {
  constructor(private readonly db: Database.Database) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        invoice_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_retry_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(webhook_id) REFERENCES subscriptions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_logs_status_retry
        ON webhook_delivery_logs(status, next_retry_at)
        WHERE status IN ('pending', 'failed');
    `);
  }

  enqueue(
    webhookId: string,
    event: string,
    invoiceId: number,
    payload: unknown,
  ): DeliveryLog {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO webhook_delivery_logs (
        webhook_id, event, invoice_id, payload,
        status, attempts, max_attempts, next_retry_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      webhookId,
      event,
      invoiceId,
      JSON.stringify(payload),
      'pending',
      0,
      MAX_ATTEMPTS,
      now,
      now,
      now,
    );

    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): DeliveryLog | undefined {
    const stmt = this.db.prepare(`
      SELECT
        id, webhook_id, event, invoice_id, payload,
        status, attempts, max_attempts, next_retry_at,
        last_error, created_at, updated_at
      FROM webhook_delivery_logs
      WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return undefined;

    return this.rowToLog(row);
  }

  getPending(limit: number = 10): DeliveryLog[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT
        id, webhook_id, event, invoice_id, payload,
        status, attempts, max_attempts, next_retry_at,
        last_error, created_at, updated_at
      FROM webhook_delivery_logs
      WHERE status IN ('pending', 'failed')
        AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(now, limit) as any[];
    return rows.map((r) => this.rowToLog(r));
  }

  recordSuccess(id: number): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE webhook_delivery_logs
      SET status = 'delivered', updated_at = ?
      WHERE id = ?
    `);

    stmt.run(now, id);
  }

  recordFailure(id: number, error: string): void {
    const now = Date.now();
    const log = this.get(id);
    if (!log) return;

    const nextAttempt = log.attempts + 1;
    const delay = RETRY_DELAYS_MS[log.attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 30000;
    const nextRetryAt = nextAttempt < log.maxAttempts ? now + delay : now;

    const newStatus = nextAttempt >= log.maxAttempts ? 'failed' : 'pending';

    const stmt = this.db.prepare(`
      UPDATE webhook_delivery_logs
      SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(newStatus, nextAttempt, error, nextRetryAt, now, id);
  }

  recordSkipped(id: number, reason: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE webhook_delivery_logs
      SET status = 'skipped', last_error = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(reason, now, id);
  }

  private rowToLog(row: any): DeliveryLog {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      event: row.event,
      invoiceId: row.invoice_id,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextRetryAt: row.next_retry_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
