import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './database/db.js';
import { createApp } from './app.js';
import { EventWebSocketEndpoint } from './api/websocket.js';
import { createSqlEventRepository } from './db/eventRepository.js';
import { createEventListener } from './ingestion/eventListener.js';
import { createIngestionLock } from './ingestion/ingestionLock.js';

const db = getDb(config.dbPath);
const app = createApp(db, { apiKeys: config.apiKeys });
const eventRepository = createSqlEventRepository(db);
const eventListener = createEventListener({
  repository: eventRepository,
  horizonUrl: config.horizonUrl,
  contractAddress: config.contractId,
});
const ingestionLock = createIngestionLock({ db });
const ingestionAbort = new AbortController();

const httpServer = createServer(app);
const wsEndpoint = new EventWebSocketEndpoint({ server: httpServer, path: '/events' });
wsEndpoint.start();

/**
 * Ingestion is single-writer: only the process holding the SQLite lease lock
 * consumes the Horizon stream. API-only replicas set INGESTION_ENABLED=false.
 * See docs/monitoring-runbook.md and docs/indexer-ha.md.
 */
if (config.ingestionEnabled && config.contractId) {
  void ingestionLock
    .runAsLeader(async (signal) => {
      const stopOnAbort = () => eventListener.stop();
      signal.addEventListener('abort', stopOnAbort, { once: true });
      try {
        await eventListener.start();
      } finally {
        signal.removeEventListener('abort', stopOnAbort);
      }
    }, ingestionAbort.signal)
    .catch((error) => {
      console.error('Indexer ingestion loop exited unexpectedly:', error);
    });
} else if (!config.contractId) {
  console.warn('ILN_CONTRACT_ID/CONTRACT_ID is not set; event ingestion is disabled.');
} else {
  console.info('INGESTION_ENABLED=false; running as read-only API replica.');
}

httpServer.listen(config.port, () => {
  console.log(`ILN Indexer API running on port ${config.port} (HTTP + WebSocket /events)`);
});

function shutdown() {
  ingestionAbort.abort();
  eventListener.stop();
  ingestionLock.release();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { wsEndpoint, eventListener, ingestionLock };
