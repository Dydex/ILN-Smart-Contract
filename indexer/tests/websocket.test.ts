import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { EventWebSocketEndpoint, matchesFilter, normalizeFilter } from '../src/api/websocket';

function waitFor<T>(emitter: any, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

describe('websocket endpoint', () => {
  let httpServer: Server;
  let endpoint: EventWebSocketEndpoint;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    endpoint = new EventWebSocketEndpoint({
      server: httpServer,
      path: '/events',
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 150,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
    endpoint.start();
  });

  afterEach(async () => {
    endpoint.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('delivers events matching subscription filter', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(JSON.stringify({ action: 'subscribe', filter: { types: ['InvoiceFunded'] } }));
    await new Promise((r) => setTimeout(r, 20));

    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    endpoint.publish({ type: 'InvoiceFunded', invoiceId: 1 });
    endpoint.publish({ type: 'InvoicePaid', invoiceId: 2 });
    await new Promise((r) => setTimeout(r, 30));

    const events = received.filter((m) => m.event);
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('InvoiceFunded');
    client.close();
  });

  it('filters by address when subscribed with one', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(
      JSON.stringify({ action: 'subscribe', filter: { types: ['InvoicePaid'], address: 'GABC' } }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    endpoint.publish({ type: 'InvoicePaid', address: 'GXYZ' });
    endpoint.publish({ type: 'InvoicePaid', address: 'GABC' });
    await new Promise((r) => setTimeout(r, 30));

    const events = received.filter((m) => m.event);
    expect(events).toHaveLength(1);
    expect(events[0].event.address).toBe('GABC');
    client.close();
  });

  it('terminates clients that do not respond to heartbeat', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    (client as any)._receiver.removeAllListeners('ping');
    client.on('ping', () => {
      /* swallow */
    });
    expect(endpoint.connectionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(endpoint.connectionCount()).toBe(0);
  });

  it('rejects connections over maxConnectionsPerIp', async () => {
    const clients: WebSocket[] = [];
    let rejected = false;

    for (let i = 0; i < 6; i++) {
      const client = new WebSocket(`ws://localhost:${port}/events`);
      clients.push(client);

      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        client.on('open', done);
        client.on('close', (code, reason) => {
          if (code === 1013 && reason.toString() === 'max_connections_per_ip') {
            rejected = true;
          }
          done();
        });
        client.on('error', done);
      });
    }

    // Give the server a tick to finish closing the over-limit socket.
    await new Promise((r) => setTimeout(r, 50));
    expect(rejected).toBe(true);
    for (const c of clients) c.close();
  });
});
describe('filter helpers', () => {
  it('normalizeFilter strips invalid types', () => {
    const f = normalizeFilter({ types: ['A', 1, 'B'], address: 'G1' });
    expect(f.types).toEqual(['A', 'B']);
    expect(f.address).toBe('G1');
  });

  it('matchesFilter returns true when filter null', () => {
    expect(matchesFilter({ type: 'X' }, null)).toBe(true);
  });

  it('matchesFilter rejects mismatched type', () => {
    expect(matchesFilter({ type: 'X' }, { types: ['Y'] })).toBe(false);
  });
});
