import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailSubscriptionsRouter } from '../src/api/email';
import { EmailDeliveryService } from '../src/delivery/emailDelivery';
import { EmailSubscriptionStore } from '../src/subscriptions/emailSubscriptionStore';
import { createSubscriptionTokenService } from '../src/subscriptions/emailToken';

function makeApp(options?: {
  publicUrl?: string;
  sendImpl?: (message: { to: string; subject: string; html: string; text?: string }) => Promise<{ id: string }>;
}) {
  let nowMs = 1_700_000_000_000;
  const store = new EmailSubscriptionStore();
  const sentEmails: Array<{ to: string; subject: string; html: string; text?: string }> = [];
  const client = {
    send: vi.fn(
      options?.sendImpl ??
        (async (message: { to: string; subject: string; html: string; text?: string }) => {
          sentEmails.push(message);
          return { id: 'msg_1' };
        }),
    ),
  };
  const delivery = new EmailDeliveryService(client, 'noreply@iln.dev');

  const app = express();
  app.use(express.json());
  app.use(
    createEmailSubscriptionsRouter(store, delivery, {
      tokenSecret: 'test-secret',
      publicUrl: options?.publicUrl ?? 'https://notifications.example.com',
      now: () => nowMs,
      verificationTtlMs: 60_000,
      unsubscribeTtlMs: 120_000,
    }),
  );

  return {
    app,
    store,
    sentEmails,
    client,
    advanceTime(ms: number) {
      nowMs += ms;
      return nowMs;
    },
    currentTime() {
      return nowMs;
    },
  };
}

function extractToken(html: string, fragment: string): string {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  const href = hrefs.find((value) => value.includes(fragment));

  if (!href) {
    throw new Error(`Could not find link for ${fragment}`);
  }

  const token = new URL(href).searchParams.get('token');
  if (!token) {
    throw new Error(`Could not find token for ${fragment}`);
  }

  return token;
}

describe('email subscriptions router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid subscription bodies and unsupported event lists', async () => {
    const { app } = makeApp();

    const invalidBody = await request(app).post('/subscriptions/email').send({
      email: 'user@example.com',
      events: ['invoice.paid'],
    });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body.error).toBe('invalid_body');

    const unsupportedEvents = await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid', 'not-a-real-event'],
    });
    expect(unsupportedEvents.status).toBe(400);
    expect(unsupportedEvents.body.error).toBe('unsupported_event_types');
  });

  it('creates a pending subscription and sends a verification email', async () => {
    const { app, store, sentEmails } = makeApp();

    const res = await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.submitted', 'invoice.paid'],
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.consentAt).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe('pending');
    expect(store.list()[0]?.consentAt).toBeNull();
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('user@example.com');
    expect(sentEmails[0]?.subject).toContain('Verify your ILN email notifications');
    expect(sentEmails[0]?.html).toContain('/subscriptions/verify?token=');
    expect(sentEmails[0]?.html).toContain('/subscriptions/email?token=');
  });

  it('returns 502 when verification email delivery fails', async () => {
    const { app } = makeApp({
      sendImpl: async () => {
        throw new Error('resend down');
      },
    });

    const res = await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid'],
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('verification_email_failed');
  });

  it('rejects missing and invalid verification tokens', async () => {
    const { app } = makeApp();

    const missing = await request(app).get('/subscriptions/verify');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('missing_token');

    const invalid = await request(app).get('/subscriptions/verify').query({ token: 'bad-token' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('invalid_token');
  });

  it('activates a subscription when the verification token is used', async () => {
    const { app, store, sentEmails, advanceTime, currentTime } = makeApp();

    const createRes = await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.submitted'],
    });

    const verifyToken = extractToken(sentEmails[0]!.html, '/subscriptions/verify');
    advanceTime(5_000);

    const verifyRes = await request(app).get('/subscriptions/verify').query({ token: verifyToken });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.status).toBe('active');
    expect(verifyRes.body.consentAt).toBe(currentTime());

    const subscription = store.get(createRes.body.id);
    expect(subscription?.status).toBe('active');
    expect(subscription?.consentAt).toBe(currentTime());

    // Single-use token replay should be rejected
    const replayRes = await request(app).get('/subscriptions/verify').query({ token: verifyToken });
    expect(replayRes.status).toBe(400);
    expect(replayRes.body.error).toBe('invalid_token');
  });

  it('returns 404 when a verification token references a missing subscription', async () => {
    const { app } = makeApp();
    const tokenService = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });
    const token = tokenService.sign({
      purpose: 'verify',
      subscriptionId: 'missing',
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    const res = await request(app).get('/subscriptions/verify').query({ token });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('subscription_not_found');
  });

  it('rejects missing and invalid unsubscribe tokens', async () => {
    const { app } = makeApp();

    const missing = await request(app).delete('/subscriptions/email');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('missing_token');

    const invalid = await request(app).delete('/subscriptions/email').query({ token: 'bad-token' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('invalid_token');
  });

  it('accepts unsubscribe tokens from the request body and header', async () => {
    const { app, sentEmails } = makeApp();

    await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid'],
    });

    const token = extractToken(sentEmails[0]!.html, '/subscriptions/email');

    const bodyRes = await request(app).delete('/subscriptions/email').send({ token });
    expect(bodyRes.status).toBe(200);

    await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid'],
    });
    const headerToken = extractToken(sentEmails[1]!.html, '/subscriptions/email');
    const headerRes = await request(app)
      .delete('/subscriptions/email')
      .set('x-subscription-token', headerToken);

    expect(headerRes.status).toBe(200);
  });

  it('unsubscribes with the signed token from the footer', async () => {
    const { app, store, sentEmails } = makeApp();

    const createRes = await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid'],
    });

    const unsubscribeToken = extractToken(sentEmails[0]!.html, '/subscriptions/email');
    const unsubscribeRes = await request(app)
      .delete('/subscriptions/email')
      .query({ token: unsubscribeToken });

    expect(unsubscribeRes.status).toBe(200);
    expect(unsubscribeRes.body.status).toBe('unsubscribed');

    const subscription = store.get(createRes.body.id);
    expect(subscription?.status).toBe('unsubscribed');
    expect(subscription?.unsubscribedAt).toBeGreaterThan(0);
  });

  it('returns 404 when an unsubscribe token references a missing subscription', async () => {
    const { app } = makeApp();
    const tokenService = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });
    const token = tokenService.sign({
      purpose: 'unsubscribe',
      subscriptionId: 'missing',
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    const res = await request(app).delete('/subscriptions/email').query({ token });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('subscription_not_found');
  });

  it('returns 409 when a verified subscription has already been unsubscribed', async () => {
    const { app, sentEmails } = makeApp();

    await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.paid'],
    });

    const verifyToken = extractToken(sentEmails[0]!.html, '/subscriptions/verify');
    const unsubscribeToken = extractToken(sentEmails[0]!.html, '/subscriptions/email');

    const unsubscribeRes = await request(app).delete('/subscriptions/email').query({ token: unsubscribeToken });
    expect(unsubscribeRes.status).toBe(200);

    const verifyRes = await request(app).get('/subscriptions/verify').query({ token: verifyToken });
    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.error).toBe('subscription_unsubscribed');
  });

  it.each(['', 'not a url'] as const)('falls back to localhost when publicUrl is %p', async (publicUrl) => {
    const { app, sentEmails } = makeApp({ publicUrl });

    await request(app).post('/subscriptions/email').send({
      address: 'GABCDE1234567890',
      email: 'user@example.com',
      events: ['invoice.submitted'],
    });

    expect(sentEmails[0]?.html).toContain('http://localhost:3001/subscriptions/verify?token=');
    expect(sentEmails[0]?.html).toContain('http://localhost:3001/subscriptions/email?token=');
  });
});
