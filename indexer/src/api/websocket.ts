import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';

export interface IndexedEvent {
  type: string;
  address?: string;
  invoiceId?: number;
  data?: unknown;
  ledger?: number;
  timestamp?: number;
}

export interface SubscriptionFilter {
  types?: string[];
  address?: string;
}

export interface WsEndpointOptions {
  path?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
}

interface ClientState {
  ws: WebSocket;
  filter: SubscriptionFilter | null;
  alive: boolean;
  lastPongAt: number;
  ip: string;
}

const DEFAULT_HEARTBEAT_INTERVAL = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 30_000;
const DEFAULT_MAX_CONNECTIONS = 1000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;

function getIpFromReq(req: IncomingMessage | undefined): string {
  if (!req) return 'unknown';
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    if (typeof xForwardedFor === 'string') return xForwardedFor.split(',')[0].trim();
    if (Array.isArray(xForwardedFor)) return xForwardedFor[0].split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export class EventWebSocketEndpoint {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly ipCounts = new Map<string, number>();
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: WsEndpointOptions & { server?: Server; noServer?: boolean } = {}) {
    this.heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxConnectionsPerIp = opts.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
    this.wss = new WebSocketServer({
      server: opts.server,
      path: opts.path ?? '/events',
      noServer: opts.noServer,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), this.heartbeatInterval);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.ipCounts.clear();
    this.wss.close();
  }

  connectionCount(): number {
    return this.clients.size;
  }

  publish(event: IndexedEvent): number {
    let sent = 0;
    const payload = JSON.stringify({ event });
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!matchesFilter(event, client.filter)) continue;
      client.ws.send(payload);
      sent += 1;
    }
    return sent;
  }

  handleUpgrade(req: Parameters<WebSocketServer['handleUpgrade']>[0], socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, 'max_connections');
      return;
    }

    const ip = getIpFromReq(req);
    const count = this.ipCounts.get(ip) || 0;
    if (count >= this.maxConnectionsPerIp) {
      ws.close(1013, 'max_connections_per_ip');
      return;
    }
    this.ipCounts.set(ip, count + 1);

    const state: ClientState = {
      ws,
      filter: null,
      alive: true,
      lastPongAt: Date.now(),
      ip,
    };
    this.clients.add(state);

    ws.on('message', (raw) => this.onMessage(state, raw.toString()));
    ws.on('pong', () => {
      state.alive = true;
      state.lastPongAt = Date.now();
    });
    ws.on('close', () => {
      this.clients.delete(state);
      const currentCount = this.ipCounts.get(ip) || 0;
      if (currentCount <= 1) {
        this.ipCounts.delete(ip);
      } else {
        this.ipCounts.set(ip, currentCount - 1);
      }
    });
    ws.on('error', () => {
      this.clients.delete(state);
      const currentCount = this.ipCounts.get(ip) || 0;
      if (currentCount <= 1) {
        this.ipCounts.delete(ip);
      } else {
        this.ipCounts.set(ip, currentCount - 1);
      }
    });
  }

  private onMessage(state: ClientState, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      state.ws.send(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    if (msg && msg.action === 'subscribe') {
      state.filter = normalizeFilter(msg.filter ?? msg);
      state.ws.send(JSON.stringify({ ack: 'subscribed', filter: state.filter }));
      return;
    }
    if (msg && msg.action === 'unsubscribe') {
      state.filter = null;
      state.ws.send(JSON.stringify({ ack: 'unsubscribed' }));
      return;
    }
    if (msg && (msg.types || msg.address)) {
      state.filter = normalizeFilter(msg);
      state.ws.send(JSON.stringify({ ack: 'subscribed', filter: state.filter }));
    }
  }

  private runHeartbeat(): void {
    const now = Date.now();
    for (const client of [...this.clients]) {
      if (!client.alive && now - client.lastPongAt >= this.heartbeatTimeout) {
        client.ws.terminate();
        this.clients.delete(client);
        const currentCount = this.ipCounts.get(client.ip) || 0;
        if (currentCount <= 1) {
          this.ipCounts.delete(client.ip);
        } else {
          this.ipCounts.set(client.ip, currentCount - 1);
        }
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.clients.delete(client);
        const currentCount = this.ipCounts.get(client.ip) || 0;
        if (currentCount <= 1) {
          this.ipCounts.delete(client.ip);
        } else {
          this.ipCounts.set(client.ip, currentCount - 1);
        }
      }
    }
  }
}

export function normalizeFilter(input: any): SubscriptionFilter {
  const out: SubscriptionFilter = {};
  if (Array.isArray(input?.types)) {
    out.types = input.types.filter((t: unknown) => typeof t === 'string');
  }
  if (typeof input?.address === 'string') {
    out.address = input.address;
  }
  return out;
}

export function matchesFilter(
  event: IndexedEvent,
  filter: SubscriptionFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.address && event.address && filter.address !== event.address) {
    return false;
  }
  return true;
}
