import { formatAmount, formatDueDate, renderInvoiceEmail, type EmailContent, type EmailDetail } from './common.js';

export interface InvoiceEmailBaseInput {
  invoiceId: number;
  token: string;
  amount: string;
  dueDate: number;
  recipientAddress: string;
  freelancer?: string | undefined;
  payer?: string | undefined;
  funder?: string | undefined;
  invoiceUrl?: string | undefined;
  unsubscribeUrl: string;
}

function sharedDetails(input: InvoiceEmailBaseInput): EmailDetail[] {
  return [
    { label: 'Recipient address', value: input.recipientAddress },
    { label: 'Freelancer', value: input.freelancer ?? 'Not provided' },
    { label: 'Payer', value: input.payer ?? 'Not provided' },
    { label: 'Funder', value: input.funder ?? 'Not provided' },
    { label: 'Token', value: input.token },
    { label: 'Amount', value: formatAmount(input.amount, input.token) },
    { label: 'Due date', value: formatDueDate(input.dueDate) },
  ];
}

export function buildInvoiceFundedEmail(input: InvoiceEmailBaseInput): EmailContent {
  return renderInvoiceEmail({
    eyebrow: 'Invoice funded update',
    heading: `Invoice #${input.invoiceId} funded`,
    summaryLines: [
      `Your invoice #${input.invoiceId} has been funded and is now ready for the next step.`,
      'You are receiving this because your Stellar address is subscribed to funded invoice updates.',
    ],
    details: sharedDetails(input),
    action: input.invoiceUrl
      ? {
          label: 'View invoice',
          url: input.invoiceUrl,
        }
      : undefined,
    unsubscribeUrl: input.unsubscribeUrl,
  });
}

