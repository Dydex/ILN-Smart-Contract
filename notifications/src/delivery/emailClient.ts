import { Resend } from 'resend';
import type { EmailClient, EmailMessage } from './emailDelivery.js';
import { sanitizeHeader } from '../templates/common.js';

export interface ResendEmailClientOptions {
  apiKey?: string;
  from: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export function createEmailClient(options: ResendEmailClientOptions): EmailClient {
  const cleanFrom = sanitizeHeader(options.from);

  if (!options.apiKey) {
    return {
      async send(message: EmailMessage) {
        const cleanTo = sanitizeHeader(message.to);
        options.logger?.warn(
          `RESEND_API_KEY is not set; skipping real email delivery to ${cleanTo}`
        );
        return { id: `local_${Date.now().toString(36)}` };
      },
    };
  }

  const resend = new Resend(options.apiKey);

  return {
    async send(message: EmailMessage) {
      const cleanTo = sanitizeHeader(message.to);
      const cleanSubject = sanitizeHeader(message.subject);

      const sendOptions: any = {
        from: cleanFrom,
        to: cleanTo,
        subject: cleanSubject,
        html: message.html,
      };
      if (message.text !== undefined) {
        sendOptions.text = message.text;
      }

      const response = await resend.emails.send(sendOptions);

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (!response.data?.id) {
        throw new Error('Resend response did not include an email id');
      }

      return { id: response.data.id };
    },
  };
}
