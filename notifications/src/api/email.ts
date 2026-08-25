import { Router } from 'express';
import type { EmailDeliveryService } from '../delivery/emailDelivery.js';
import type { EmailSubscriptionStore } from '../subscriptions/emailSubscriptionStore.js';
import { createSubscriptionTokenService } from '../subscriptions/emailToken.js';
import { buildVerificationEmail } from '../email/verificationEmail.js';

const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_EVENTS = new Set([
  'invoice.submitted',
  'invoice.funded',
  'invoice.paid',
  'invoice.expiring_soon',
  'invoice.cancelled',
  'invoice.expired',
  'invoice.disputed',
  'reputation.updated',
]);

export interface EmailSubscriptionRouterOptions {
  tokenSecret: string;
  publicUrl: string;
  now?: (() => number) | undefined;
  verificationTtlMs?: number | undefined;
  unsubscribeTtlMs?: number | undefined;
}

export function createEmailSubscriptionsRouter(
  store: EmailSubscriptionStore,
  delivery: EmailDeliveryService,
  options: EmailSubscriptionRouterOptions,
): Router {
  const router = Router();
  const tokenService = createSubscriptionTokenService({
    secret: options.tokenSecret,
    now: options.now,
  });
  const now = options.now ?? Date.now;
  const verificationTtlMs = options.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS;
  const unsubscribeTtlMs = options.unsubscribeTtlMs ?? DEFAULT_UNSUBSCRIBE_TTL_MS;
  const publicUrl = normalizeBaseUrl(options.publicUrl);

  router.post('/subscriptions/email', async (req, res) => {
    const { address, email, events } = req.body ?? {};

    if (!isNonEmptyString(address) || !EMAIL_RE.test(String(email ?? ''))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }

    if (!Array.isArray(events) || events.length === 0 || !events.every(isValidEventType)) {
      res.status(400).json({ error: 'unsupported_event_types' });
      return;
    }

    const normalizedEvents = normalizeEventTypes(events);
    const subscription = store.create({
      address: address.trim(),
      email: String(email).trim().toLowerCase(),
      eventTypes: normalizedEvents,
    });

    const verifyToken = tokenService.sign({
      purpose: 'verify',
      subscriptionId: subscription.id,
      address: subscription.address,
      email: subscription.email,
      ttlMs: verificationTtlMs,
    });
    const unsubscribeToken = tokenService.sign({
      purpose: 'unsubscribe',
      subscriptionId: subscription.id,
      address: subscription.address,
      email: subscription.email,
      ttlMs: unsubscribeTtlMs,
    });

    const verifyUrl = new URL('/subscriptions/verify', publicUrl);
    verifyUrl.searchParams.set('token', verifyToken);

    const unsubscribeUrl = new URL('/subscriptions/email', publicUrl);
    unsubscribeUrl.searchParams.set('token', unsubscribeToken);

    const message = buildVerificationEmail({
      address: subscription.address,
      email: subscription.email,
      eventTypes: subscription.eventTypes,
      verifyUrl: verifyUrl.toString(),
      unsubscribeUrl: unsubscribeUrl.toString(),
    });

    const result = await delivery.send({
      to: subscription.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (!result.ok) {
      res.status(502).json({ error: 'verification_email_failed' });
      return;
    }

    res.status(202).json({
      id: subscription.id,
      address: subscription.address,
      email: subscription.email,
      events: subscription.eventTypes,
      status: subscription.status,
      consentAt: subscription.consentAt,
    });
  });

  router.get('/subscriptions/verify', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'missing_token' });
      return;
    }

    const payload = tokenService.consume(token);
    if (!payload || payload.purpose !== 'verify') {
      res.status(400).json({ error: 'invalid_token' });
      return;
    }

    const subscription = store.activate(payload.subscriptionId, now());
    if (!subscription) {
      res.status(404).json({ error: 'subscription_not_found' });
      return;
    }

    if (subscription.status === 'unsubscribed') {
      res.status(409).json({ error: 'subscription_unsubscribed' });
      return;
    }

    res.json({
      id: subscription.id,
      address: subscription.address,
      email: subscription.email,
      events: subscription.eventTypes,
      status: subscription.status,
      consentAt: subscription.consentAt,
    });
  });

  router.delete('/subscriptions/email', (req, res) => {
    const token = readTokenFromRequest(req);
    if (!token) {
      res.status(400).json({ error: 'missing_token' });
      return;
    }

    const payload = tokenService.verify(token);
    if (!payload || payload.purpose !== 'unsubscribe') {
      res.status(400).json({ error: 'invalid_token' });
      return;
    }

    const subscription = store.unsubscribe(payload.subscriptionId, now());
    if (!subscription) {
      res.status(404).json({ error: 'subscription_not_found' });
      return;
    }

    res.json({
      id: subscription.id,
      status: subscription.status,
      unsubscribedAt: subscription.unsubscribedAt,
    });
  });

  return router;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidEventType(value: unknown): value is string {
  return typeof value === 'string' && VALID_EVENTS.has(value.trim());
}

function normalizeEventTypes(events: string[]): string[] {
  return [...new Set(events.map((event) => event.trim()))];
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    return 'http://localhost:3001';
  }

  try {
    const parsed = new URL(normalized);
    const serialized = parsed.toString();
    return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
  } catch {
    return 'http://localhost:3001';
  }
}

function readTokenFromRequest(req: { query: Record<string, unknown>; body?: unknown; headers: Record<string, unknown> }): string {
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (queryToken) {
    return queryToken;
  }

  const body = req.body as { token?: unknown } | undefined;
  if (body && typeof body.token === 'string') {
    return body.token.trim();
  }

  const headerToken = req.headers['x-subscription-token'];
  if (typeof headerToken === 'string') {
    return headerToken.trim();
  }

  return '';
}
