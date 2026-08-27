import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './database/db.js';
import { createApp } from './app.js';
import { EventWebSocketEndpoint } from './api/websocket.js';
import { createSqlEventRepository } from './db/eventRepository.js';
import { createEventListener } from './ingestion/eventListener.js';
import { startReconciliationSchedule, createWebhookAlertDispatcher } from './reconciliation/consistencyJob.js';
import { SorobanChainReader } from './reconciliation/chainReader.js';

const db = getDb(config.dbPath);
const app = createApp(db, { apiKeys: config.apiKeys });
const eventRepository = createSqlEventRepository(db);
const eventListener = createEventListener({
  repository: eventRepository,
  horizonUrl: config.horizonUrl,
  contractAddress: config.contractId,
});

const httpServer = createServer(app);
const wsEndpoint = new EventWebSocketEndpoint({ server: httpServer, path: '/events' });
wsEndpoint.start();

if (config.contractId) {
  void eventListener.start().catch((error) => {
    console.error('Indexer ingestion loop exited unexpectedly:', error);
  });

  if (process.env.RECONCILIATION_ENABLED === 'true') {
    const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
    const chainReader = new SorobanChainReader({
      rpcUrl,
      contractId: config.contractId,
      networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    });
    const alertUrl = process.env.RECONCILIATION_ALERT_URL;
    if (alertUrl) {
      startReconciliationSchedule(db, chainReader, {
        alert: createWebhookAlertDispatcher(alertUrl),
      });
    } else {
      startReconciliationSchedule(db, chainReader);
    }
    console.log('Continuous reconciliation schedule started.');
  }
} else {
  console.warn('ILN_CONTRACT_ID/CONTRACT_ID is not set; event ingestion is disabled.');
}

httpServer.listen(config.port, () => {
  console.log(`ILN Indexer API running on port ${config.port} (HTTP + WebSocket /events)`);
});

export { wsEndpoint, eventListener };
