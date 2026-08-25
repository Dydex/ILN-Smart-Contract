export interface TelegramInvoiceEvent {
  type: 'invoice.submitted' | 'invoice.funded' | 'invoice.paid' | 'invoice.expiring_soon' | 'invoice.disputed';
  invoiceId: number;
  token: 'USDC' | 'EURC' | 'XLM';
  amount: string;
  dueDate: number;
  freelancer?: string;
  payer?: string;
  funder?: string;
  invoiceUrl?: string;
}

const TOKEN_EMOJI: Record<string, string> = {
  USDC: '\u{1F535}',
  EURC: '\u{1F7E0}',
  XLM: '\u{26AB}',
  default: '\u{26AB}',
};

function tokenEmoji(token: string): string {
  return TOKEN_EMOJI[token] ?? TOKEN_EMOJI.default ?? '▫️';
}

function formatAmount(amount: string, token: string): string {
  const num = parseInt(amount, 10);
  const decimals = 7;
  const formatted = (num / 10 ** decimals).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
  return `${formatted} ${token}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toUTCString();
}

function escapeMarkdown(text: string): string {
  // Simple escape for standard Markdown if necessary, though standard Markdown is quite forgiving.
  // We'll leave it simple.
  return text;
}

export function buildTelegramMessage(event: TelegramInvoiceEvent): string {
  const emoji = tokenEmoji(event.token);
  const amountStr = formatAmount(event.amount, event.token);
  const title = `*${emoji} Invoice #${event.invoiceId} ${event.type.replace('invoice.', '')}*`;

  let body = `${title}\n\n`;
  body += `*Token:* ${event.token}\n`;
  body += `*Amount:* ${amountStr}\n`;

  if (event.freelancer) {
    body += `*Freelancer:* \`${escapeMarkdown(event.freelancer)}\`\n`;
  }
  if (event.payer) {
    body += `*Payer:* \`${escapeMarkdown(event.payer)}\`\n`;
  }
  if (event.funder) {
    body += `*Funder:* \`${escapeMarkdown(event.funder)}\`\n`;
  }

  body += `*Due Date:* ${formatDate(event.dueDate)}\n`;

  if (event.invoiceUrl) {
    body += `\n[View Invoice](${event.invoiceUrl})`;
  }

  return body;
}

export type TelegramHttpClient = (
  url: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number }>;

export async function deliverTelegramNotification(
  botToken: string,
  chatId: string,
  event: TelegramInvoiceEvent,
  http: TelegramHttpClient,
): Promise<{ ok: boolean; status: number }> {
  const text = buildTelegramMessage(event);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };

  try {
    const res = await http(url, payload);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
