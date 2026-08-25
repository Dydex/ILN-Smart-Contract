export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailDetail {
  label: string;
  value: string;
}

export interface RenderInvoiceEmailOptions {
  eyebrow?: string | undefined;
  heading: string;
  summaryLines: string[];
  details: EmailDetail[];
  unsubscribeUrl: string;
  action?: EmailAction | undefined;
}

const DEFAULT_FONT =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export function escapeHtml(value: string): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

export function sanitizeHeader(value: string): string {
  if (!value) return '';
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') return '#';
  const trimmed = url.trim().replace(/[\r\n\t]+/g, '');
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) {
    return '#';
  }
  if (/^https?:\/\//i.test(trimmed) || /^\//.test(trimmed)) {
    return trimmed;
  }
  return '#';
}

export function formatAmount(amount: string, token: string): string {
  const parsed = Number.parseInt(amount, 10);
  if (!Number.isFinite(parsed)) {
    return `${amount} ${token}`;
  }

  const decimals = 7;
  const formatted = (parsed / 10 ** decimals).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });

  return `${formatted} ${token}`;
}

export function formatDueDate(dueDate: number): string {
  return new Date(dueDate * 1000).toUTCString();
}

export function renderInvoiceEmail(options: RenderInvoiceEmailOptions): EmailContent {
  const summaryHtml = options.summaryLines
    .map((line) => `<p style="margin: 0 0 12px; color: #374151;">${escapeHtml(line)}</p>`)
    .join('');

  const detailsHtml = options.details
    .map(
      (detail) => `
        <div style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
          <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280;">
            ${escapeHtml(detail.label)}
          </div>
          <div style="margin-top: 6px; font-size: 15px; line-height: 1.5; color: #111827;">
            ${escapeHtml(detail.value)}
          </div>
        </div>
      `,
    )
    .join('');

  const safeActionUrl = options.action ? sanitizeUrl(options.action.url) : '';
  const actionHtml = options.action
    ? `
      <p style="margin: 28px 0 0;">
        <a
          href="${escapeAttribute(safeActionUrl)}"
          style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; font-weight: 600; padding: 12px 18px; border-radius: 999px;"
        >
          ${escapeHtml(options.action.label)}
        </a>
      </p>
    `
    : '';

  const safeUnsubscribeUrl = sanitizeUrl(options.unsubscribeUrl);

  const html = `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%); color: #111827; font-family: ${DEFAULT_FONT};">
    <div style="max-width: 680px; margin: 0 auto; padding: 32px 16px 48px;">
      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 24px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08); overflow: hidden;">
        <div style="padding: 28px 32px 0;">
          <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #6b7280;">ILN Notifications</div>
          <h1 style="margin: 12px 0 16px; font-size: 32px; line-height: 1.1;">${escapeHtml(options.heading)}</h1>
          ${options.eyebrow ? `<p style="margin: 0 0 16px; color: #4b5563; font-size: 15px;">${escapeHtml(options.eyebrow)}</p>` : ''}
          ${summaryHtml}
        </div>
        <div style="padding: 8px 32px 0;">
          ${detailsHtml}
        </div>
        <div style="padding: 0 32px 32px;">
          ${actionHtml}
          <p style="margin: 28px 0 0; font-size: 12px; line-height: 1.6; color: #6b7280;">
            If you no longer want these updates, you can
            <a href="${escapeAttribute(safeUnsubscribeUrl)}" style="color: #111827; font-weight: 600;">unsubscribe here</a>.
          </p>
        </div>
      </div>
    </div>
  </body>
</html>`;

  const textLines = [
    sanitizeHeader(options.heading),
    '',
    ...options.summaryLines,
    '',
    ...options.details.map((detail) => `${detail.label}: ${detail.value}`),
  ];

  if (options.action) {
    textLines.push('', `${options.action.label}: ${safeActionUrl}`);
  }

  textLines.push('', `Unsubscribe: ${safeUnsubscribeUrl}`);

  return {
    subject: sanitizeHeader(options.heading),
    html,
    text: textLines.join('\n'),
  };
}

