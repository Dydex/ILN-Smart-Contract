import { Router } from 'express';
import type { EmailDeliveryService } from '../delivery/emailDelivery.js';
import type { EmailSubscriptionStore } from '../subscriptions/emailSubscriptionStore.js';
import {
  resolveRecipientAddresses,
  sendNotificationEmails,
  type InvoiceEmailEvent,
  type InvoiceEmailEventType,
} from '../delivery/email.js';

const VALID_EMAIL_EVENTS = new Set<InvoiceEmailEventType>([
  'invoice.funded',
  'invoice.paid',
  'invoice.expiring_soon',
  'invoice.disputed',
]);

export interface EmailNotificationsRouterOptions {
  tokenSecret: string;
  publicUrl: string;
  now?: (() => number) | undefined;
  unsubscribeTtlMs?: number | undefined;
}

export function createEmailNotificationsRouter(
  store: EmailSubscriptionStore,
  delivery: EmailDeliveryService,
  options: EmailNotificationsRouterOptions,
): Router {
  const router = Router();

  router.post('/notify/email', async (req, res) => {
    const event = req.body as Partial<InvoiceEmailEvent> | undefined;
    if (!isValidEmailEvent(event)) {
      res.status(400).json({ error: 'invalid_event_body' });
      return;
    }

    const recipients = new Set(resolveRecipientAddresses(event));
    if (recipients.size === 0) {
      res.status(400).json({ error: 'missing_recipient_address' });
      return;
    }

    const subscriptions = store
      .list()
      .filter(
        (subscription) =>
          subscription.status === 'active' &&
          subscription.eventTypes.includes(event.type) &&
          recipients.has(subscription.address),
      );

    if (subscriptions.length === 0) {
      res.json({ delivered: 0, failed: 0, total: 0 });
      return;
    }

    const result = await sendNotificationEmails(delivery, subscriptions, event, {
      publicUrl: options.publicUrl,
      tokenSecret: options.tokenSecret,
      now: options.now,
      unsubscribeTtlMs: options.unsubscribeTtlMs,
    });

    res.json(result);
  });

  return router;
}

function isValidEmailEvent(value: Partial<InvoiceEmailEvent> | undefined): value is InvoiceEmailEvent {
  if (!value) {
    return false;
  }

  return (
    isValidEventType(value.type) &&
    isPositiveNumber(value.invoiceId) &&
    isNonEmptyString(value.token) &&
    isNonEmptyString(value.amount) &&
    isPositiveNumber(value.dueDate) &&
    (value.address === undefined || isNonEmptyString(value.address)) &&
    (value.freelancer === undefined || isNonEmptyString(value.freelancer)) &&
    (value.payer === undefined || isNonEmptyString(value.payer)) &&
    (value.funder === undefined || isNonEmptyString(value.funder)) &&
    (value.invoiceUrl === undefined || isNonEmptyString(value.invoiceUrl))
  );
}

function hasRecipientAddress(value: Partial<InvoiceEmailEvent>): boolean {
  return [value.address, value.freelancer, value.payer, value.funder].some(isNonEmptyString);
}

function isValidEventType(value: unknown): value is InvoiceEmailEventType {
  return typeof value === 'string' && VALID_EMAIL_EVENTS.has(value as InvoiceEmailEventType);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
