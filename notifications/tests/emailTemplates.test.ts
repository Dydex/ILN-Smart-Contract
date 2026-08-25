import { describe, expect, it, vi } from 'vitest';
import {
  buildInvoiceDisputedEmail,
  buildInvoiceExpiringSoonEmail,
  buildInvoiceFundedEmail,
  buildInvoicePaidEmail,
} from '../src/templates';
import { renderInvoiceEmail } from '../src/templates/common';

const baseInput = {
  invoiceId: 42,
  token: 'USDC' as const,
  amount: '10000000',
  dueDate: 1_700_000_000,
  recipientAddress: 'GABCDEF1234567890',
  freelancer: 'GFREELANCER123',
  payer: 'GPAYER123',
  funder: 'GFUNDER123',
  invoiceUrl: 'https://iln.app/invoices/42',
  unsubscribeUrl: 'https://notifications.example.com/subscriptions/email?token=signed',
};

describe('invoice email templates', () => {
  it.each([
    ['funded', buildInvoiceFundedEmail, 'funded'],
    ['paid', buildInvoicePaidEmail, 'paid'],
    ['disputed', buildInvoiceDisputedEmail, 'disputed'],
  ] as const)('renders %s template with unsubscribe link', (_label, builder, expectedWord) => {
    const email = builder(baseInput);

    expect(email.subject).toContain(expectedWord);
    expect(email.html).toContain(baseInput.unsubscribeUrl);
    expect(email.text).toContain(`Unsubscribe: ${baseInput.unsubscribeUrl}`);
    expect(email.html).toContain(baseInput.invoiceUrl);
    expect(email.text).toContain('Recipient address: GABCDEF1234567890');
  });

  it.each([
    buildInvoiceFundedEmail,
    buildInvoicePaidEmail,
    buildInvoiceDisputedEmail,
  ])('renders a template without an invoice link', (builder) => {
    const email = builder({
      ...baseInput,
      invoiceUrl: undefined,
    });

    expect(email.html).toContain('unsubscribe here');
    expect(email.text).toContain('Unsubscribe:');
  });

  it.each([
    buildInvoiceFundedEmail,
    buildInvoicePaidEmail,
    buildInvoiceDisputedEmail,
  ])('renders optional detail placeholders when participant addresses are missing', (builder) => {
    const email = builder({
      ...baseInput,
      freelancer: undefined,
      payer: undefined,
      funder: undefined,
      invoiceUrl: undefined,
    });

    expect(email.text).toContain('Not provided');
    expect(email.html).toContain('Not provided');
  });

  it.each([72, 24] as const)('renders expiring soon reminders for %s hours', (hours) => {
    const now = 1_700_000_000_000;
    const email = buildInvoiceExpiringSoonEmail({
      ...baseInput,
      reminderHours: hours,
      now,
    });

    expect(email.subject).toContain(`${hours} hours`);
    expect(email.html).toContain(`${hours}-hour reminder`);
    expect(email.text).toContain(`${hours}-hour reminder`);
    expect(email.html).toContain(baseInput.unsubscribeUrl);
  });

  it('derives reminder hours from due date when not explicitly provided', () => {
    const now = 1_700_000_000_000;
    const email = buildInvoiceExpiringSoonEmail({
      ...baseInput,
      dueDate: Math.floor((now + 72 * 60 * 60 * 1000) / 1000),
      now,
    });

    expect(email.subject).toContain('72 hours');
  });

  it('renders a shell without eyebrow or action copy', () => {
    const email = renderInvoiceEmail({
      heading: 'Standalone email',
      summaryLines: ['A short summary.'],
      details: [{ label: 'Field', value: 'Value' }],
      unsubscribeUrl: baseInput.unsubscribeUrl,
    });

    expect(email.subject).toBe('Standalone email');
    expect(email.html).toContain('Standalone email');
    expect(email.text).toContain('Field: Value');
  });

  describe('injection resistance and sanitization', () => {
    it('neutralizes header injection attempts with CRLF in headings and subjects', () => {
      const maliciousHeading = 'Invoice #42 funded\r\nBcc: evil@attacker.com\r\nSubject: Spoofed';
      const email = renderInvoiceEmail({
        heading: maliciousHeading,
        summaryLines: ['Summary line\r\nInjected Header: value'],
        details: [{ label: 'Field\r\nName', value: 'Value\r\nHeader: inject' }],
        unsubscribeUrl: baseInput.unsubscribeUrl,
      });

      expect(email.subject).not.toContain('\r');
      expect(email.subject).not.toContain('\n');
      expect(email.subject).toBe('Invoice #42 funded Bcc: evil@attacker.com Subject: Spoofed');
    });

    it('escapes HTML tags and script injections across all template fields', () => {
      const maliciousInput = {
        ...baseInput,
        freelancer: '<script>alert("freelancer")</script>',
        payer: '<img src=x onerror=alert(1)>',
        funder: '"><script>alert("funder")</script>',
        recipientAddress: '<b onmouseover=alert("xss")>addr</b>',
        token: '<svg onload=alert(1)>' as any,
      };

      const email = buildInvoiceFundedEmail(maliciousInput);

      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toContain('</script>');
      expect(email.html).not.toContain('<img src=x onerror=alert(1)>');
      expect(email.html).not.toContain('<svg onload=alert(1)>');

      expect(email.html).toContain('&lt;script&gt;alert(&quot;freelancer&quot;)&lt;/script&gt;');
      expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(email.html).toContain('&quot;&gt;&lt;script&gt;alert(&quot;funder&quot;)&lt;/script&gt;');
      expect(email.html).toContain('&lt;b onmouseover=alert(&quot;xss&quot;)&gt;addr&lt;/b&gt;');
    });

    it('neutralizes malicious javascript: and data: pseudo-protocols in action and unsubscribe links', () => {
      const maliciousEmail = renderInvoiceEmail({
        heading: 'Invoice update',
        summaryLines: ['Check details'],
        details: [{ label: 'Status', value: 'Pending' }],
        action: {
          label: 'View details',
          url: 'javascript:alert(document.cookie)',
        },
        unsubscribeUrl: 'data:text/html,<script>alert("evil")</script>',
      });

      expect(maliciousEmail.html).not.toContain('javascript:');
      expect(maliciousEmail.html).not.toContain('data:text/html');
      expect(maliciousEmail.html).toContain('href="#"');
    });

    it('allows legitimate https and http links in action and unsubscribe URLs', () => {
      const email = renderInvoiceEmail({
        heading: 'Legitimate email',
        summaryLines: ['All good'],
        details: [{ label: 'Status', value: 'Active' }],
        action: {
          label: 'View Invoice',
          url: 'https://app.iln.dev/invoices/123?ref=notify',
        },
        unsubscribeUrl: 'https://notifications.iln.dev/unsubscribe?token=abc.xyz',
      });

      expect(email.html).toContain('href="https://app.iln.dev/invoices/123?ref=notify"');
      expect(email.html).toContain('href="https://notifications.iln.dev/unsubscribe?token=abc.xyz"');
    });
  });
});
