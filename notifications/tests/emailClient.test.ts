import { afterEach, describe, expect, it, vi } from 'vitest';

const resendMocks = vi.hoisted(() => ({
  send: vi.fn(),
  instances: [] as Array<{ key?: string }>,
}));

vi.mock('resend', () => {
  class Resend {
    readonly emails = {
      send: resendMocks.send,
    };

    constructor(public readonly key?: string) {
      resendMocks.instances.push(this);
    }
  }

  return { Resend };
});

import { createEmailClient } from '../src/delivery/emailClient';

describe('createEmailClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resendMocks.instances.length = 0;
  });

  it('uses the Resend SDK when an API key is configured', async () => {
    resendMocks.send.mockResolvedValueOnce({
      data: { id: 'email_123' },
      error: null,
    });

    const client = createEmailClient({
      apiKey: 're_test_key',
      from: 'ILN Notifications <noreply@iln.dev>',
      logger: console,
    });

    const result = await client.send({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({ id: 'email_123' });
    expect(resendMocks.instances).toHaveLength(1);
    expect(resendMocks.instances[0]?.key).toBe('re_test_key');
    expect(resendMocks.send).toHaveBeenCalledWith({
      from: 'ILN Notifications <noreply@iln.dev>',
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('throws when Resend returns an API error', async () => {
    resendMocks.send.mockResolvedValueOnce({
      data: null,
      error: { name: 'invalid_access', message: 'api key rejected' },
    });

    const client = createEmailClient({
      apiKey: 're_test_key',
      from: 'ILN Notifications <noreply@iln.dev>',
    });

    await expect(
      client.send({
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      }),
    ).rejects.toThrow('api key rejected');
  });

  it('throws when Resend omits the email id', async () => {
    resendMocks.send.mockResolvedValueOnce({
      data: { id: '' },
      error: null,
    });

    const client = createEmailClient({
      apiKey: 're_test_key',
      from: 'ILN Notifications <noreply@iln.dev>',
    });

    await expect(
      client.send({
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      }),
    ).rejects.toThrow('Resend response did not include an email id');
  });

  it('falls back to a preview transport when no API key is configured', async () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const client = createEmailClient({
      from: 'ILN Notifications <noreply@iln.dev>',
      logger,
    });

    const result = await client.send({
      to: 'user@example.com',
      subject: 'Preview',
      html: '<p>Preview</p>',
    });

    expect(result.id).toMatch(/^local_/);
    expect(logger.warn).toHaveBeenCalledWith(
      'RESEND_API_KEY is not set; skipping real email delivery to user@example.com',
    );
  });

  it('sanitizes CRLF characters from email headers before sending', async () => {
    resendMocks.send.mockResolvedValueOnce({
      data: { id: 'email_crlf_safe' },
      error: null,
    });

    const client = createEmailClient({
      apiKey: 're_test_key',
      from: 'ILN Notifications <noreply@iln.dev>\r\nBcc: evil@attacker.com',
      logger: console,
    });

    await client.send({
      to: 'user@example.com\r\nCc: victim@example.com',
      subject: 'Invoice Paid\r\nSubject: Overridden',
      html: '<p>Hi</p>',
    });

    expect(resendMocks.send).toHaveBeenCalledWith({
      from: 'ILN Notifications <noreply@iln.dev> Bcc: evil@attacker.com',
      to: 'user@example.com Cc: victim@example.com',
      subject: 'Invoice Paid Subject: Overridden',
      html: '<p>Hi</p>',
      text: undefined,
    });
  });
});
