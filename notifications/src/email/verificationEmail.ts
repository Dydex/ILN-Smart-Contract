export interface VerificationEmailInput {
  address: string;
  email: string;
  eventTypes: string[];
  verifyUrl: string;
  unsubscribeUrl: string;
}

export interface VerificationEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function buildVerificationEmail(input: VerificationEmailInput): VerificationEmailContent {
  const events = input.eventTypes
    .map((event) => `<li>${escapeHtml(event)}</li>`)
    .join('');

  const safeVerifyUrl = sanitizeUrl(input.verifyUrl);
  const safeUnsubscribeUrl = sanitizeUrl(input.unsubscribeUrl);

  const html = `<!doctype html>
<html lang="en">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
      <h1 style="font-size: 24px; margin-bottom: 16px;">Verify your ILN notifications</h1>
      <p>You asked to receive email notifications for Stellar address <strong>${escapeHtml(input.address)}</strong>.</p>
      <p>We will send updates for:</p>
      <ul>${events}</ul>
      <p style="margin: 24px 0;">
        <a href="${escapeAttribute(safeVerifyUrl)}" style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px;">
          Verify email address
        </a>
      </p>
      <p>If you did not request these notifications, you can ignore this email or unsubscribe below.</p>
      <p style="font-size: 12px; color: #6b7280;">
        Unsubscribe: <a href="${escapeAttribute(safeUnsubscribeUrl)}">${escapeHtml(safeUnsubscribeUrl)}</a>
      </p>
    </div>
  </body>
</html>`;

  const text = [
    'Verify your ILN notifications',
    `Address: ${input.address}`,
    `Email: ${input.email}`,
    `Events: ${input.eventTypes.join(', ')}`,
    `Verify: ${safeVerifyUrl}`,
    `Unsubscribe: ${safeUnsubscribeUrl}`,
  ].join('\n');

  return {
    subject: sanitizeHeader('Verify your ILN email notifications'),
    html,
    text,
  };
}

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
