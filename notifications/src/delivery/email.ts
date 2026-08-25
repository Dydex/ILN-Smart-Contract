import type { EmailDeliveryResult, EmailDeliveryService, EmailMessage } from './emailDelivery.js';
import type { EmailSubscription } from '../subscriptions/emailSubscriptionStore.js';
import { createSubscriptionTokenService } from '../subscriptions/emailToken.js';
import {
  buildInvoiceDisputedEmail,
  buildInvoiceExpiringSoonEmail,
  buildInvoiceFundedEmail,
  buildInvoicePaidEmail,
  sanitizeHeader,
  type EmailContent,
  type InvoiceEmailBaseInput,
  type InvoiceExpiringSoonEmailInput,
} from '../templates/index.js';

export type InvoiceEmailEventType =
  | 'invoice.funded'
  | 'invoice.paid'
  | 'invoice.expiring_soon'
  | 'invoice.disputed';

export interface InvoiceEmailEvent {
  type: InvoiceEmailEventType;
  invoiceId: number;
  token: 'USDC' | 'EURC' | 'XLM';
  amount: string;
  dueDate: number;
  address?: string | undefined;
  freelancer?: string | undefined;
  payer?: string | undefined;
  funder?: string | undefined;
  invoiceUrl?: string | undefined;
}

export interface EmailNotificationOptions {
  publicUrl: string;
  tokenSecret: string;
  unsubscribeTtlMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface DeliveredEmailResult {
  delivered: number;
  failed: number;
  total: number;
}

const DEFAULT_UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function resolveRecipientAddresses(event: InvoiceEmailEvent): string[] {
  return [
    ...new Set(
      [event.address, event.freelancer, event.payer, event.funder]
        .filter(isNonEmptyString)
        .map((value) => value.trim()),
    ),
  ];
}

export function buildNotificationEmailMessage(
  subscription: EmailSubscription,
  event: InvoiceEmailEvent,
  options: EmailNotificationOptions,
): EmailMessage {
  const unsubscribeUrl = buildUnsubscribeUrl(subscription, options);
  const baseInput: InvoiceEmailBaseInput = {
    invoiceId: event.invoiceId,
    token: event.token,
    amount: event.amount,
    dueDate: event.dueDate,
    recipientAddress: subscription.address,
    freelancer: event.freelancer,
    payer: event.payer,
    funder: event.funder,
    invoiceUrl: event.invoiceUrl,
    unsubscribeUrl,
  };

  const content: EmailContent = buildContent(event, baseInput, options);
  return {
    to: sanitizeHeader(subscription.email),
    subject: sanitizeHeader(content.subject),
    html: content.html,
    text: content.text,
  };
}

export async function sendNotificationEmail(
  delivery: EmailDeliveryService,
  subscription: EmailSubscription,
  event: InvoiceEmailEvent,
  options: EmailNotificationOptions,
): Promise<EmailDeliveryResult> {
  return delivery.send(buildNotificationEmailMessage(subscription, event, options));
}

export async function sendNotificationEmails(
  delivery: EmailDeliveryService,
  subscriptions: EmailSubscription[],
  event: InvoiceEmailEvent,
  options: EmailNotificationOptions,
): Promise<DeliveredEmailResult> {
  let delivered = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const result = await sendNotificationEmail(delivery, subscription, event, options);
    if (result.ok) {
      delivered += 1;
    } else {
      failed += 1;
    }
  }

  return {
    delivered,
    failed,
    total: subscriptions.length,
  };
}

export function buildUnsubscribeUrl(
  subscription: EmailSubscription,
  options: EmailNotificationOptions,
): string {
  const tokenService = createSubscriptionTokenService({
    secret: options.tokenSecret,
    now: options.now,
  });
  const token = tokenService.sign({
    purpose: 'unsubscribe',
    subscriptionId: subscription.id,
    address: subscription.address,
    email: subscription.email,
    ttlMs: options.unsubscribeTtlMs ?? DEFAULT_UNSUBSCRIBE_TTL_MS,
  });

  const url = new URL('/subscriptions/email', normalizePublicUrl(options.publicUrl));
  url.searchParams.set('token', token);
  return url.toString();
}

function buildContent(
  event: InvoiceEmailEvent,
  baseInput: InvoiceEmailBaseInput,
  options: EmailNotificationOptions,
): EmailContent {
  if (event.type === 'invoice.expiring_soon') {
    const reminderInput: InvoiceExpiringSoonEmailInput = {
      ...baseInput,
      reminderHours: resolveReminderHours(event, options),
      now: options.now?.() ?? Date.now(),
    };
    return buildInvoiceExpiringSoonEmail(reminderInput);
  }

  switch (event.type) {
    case 'invoice.funded':
      return buildInvoiceFundedEmail(baseInput);
    case 'invoice.paid':
      return buildInvoicePaidEmail(baseInput);
    case 'invoice.disputed':
      return buildInvoiceDisputedEmail(baseInput);
    default: {
      const exhaustive: never = event.type;
      throw new Error(`Unsupported email event type: ${exhaustive}`);
    }
  }
}

function resolveReminderHours(event: InvoiceEmailEvent, options: EmailNotificationOptions): 72 | 24 {
  const now = options.now?.() ?? Date.now();
  const remainingHours = Math.round((event.dueDate * 1000 - now) / (60 * 60 * 1000));
  return remainingHours > 48 ? 72 : 24;
}

function normalizePublicUrl(publicUrl: string): string {
  const trimmed = publicUrl.trim();
  if (!trimmed) {
    return 'http://localhost:3001';
  }

  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    return 'http://localhost:3001';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
