import { formatAmount, formatDueDate, renderInvoiceEmail, type EmailContent, type EmailDetail } from './common.js';
import type { InvoiceEmailBaseInput } from './invoiceFunded.js';

export interface InvoiceExpiringSoonEmailInput extends InvoiceEmailBaseInput {
  reminderHours?: 72 | 24 | undefined;
  now?: number | undefined;
}

function resolveReminderHours(input: InvoiceExpiringSoonEmailInput): 72 | 24 {
  if (input.reminderHours === 72 || input.reminderHours === 24) {
    return input.reminderHours;
  }

  const now = input.now ?? Date.now();
  const remainingHours = Math.round((input.dueDate * 1000 - now) / (60 * 60 * 1000));
  return remainingHours > 48 ? 72 : 24;
}

function sharedDetails(input: InvoiceExpiringSoonEmailInput, reminderHours: 72 | 24): EmailDetail[] {
  return [
    { label: 'Recipient address', value: input.recipientAddress },
    { label: 'Freelancer', value: input.freelancer ?? 'Not provided' },
    { label: 'Payer', value: input.payer ?? 'Not provided' },
    { label: 'Funder', value: input.funder ?? 'Not provided' },
    { label: 'Token', value: input.token },
    { label: 'Amount', value: formatAmount(input.amount, input.token) },
    { label: 'Due date', value: formatDueDate(input.dueDate) },
    { label: 'Reminder', value: `${reminderHours}-hour reminder` },
  ];
}

export function buildInvoiceExpiringSoonEmail(input: InvoiceExpiringSoonEmailInput): EmailContent {
  const reminderHours = resolveReminderHours(input);

  return renderInvoiceEmail({
    eyebrow: 'Due date reminder',
    heading: `Invoice #${input.invoiceId} due in ${reminderHours} hours`,
    summaryLines: [
      `This is the ${reminderHours}-hour reminder for invoice #${input.invoiceId}.`,
      'We sent this because your Stellar address is subscribed to expiring invoice reminders.',
    ],
    details: sharedDetails(input, reminderHours),
    action: input.invoiceUrl
      ? {
          label: 'View invoice',
          url: input.invoiceUrl,
        }
      : undefined,
    unsubscribeUrl: input.unsubscribeUrl,
  });
}

