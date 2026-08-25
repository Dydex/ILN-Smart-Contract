import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type SubscriptionTokenPurpose = 'verify' | 'unsubscribe';

export interface SubscriptionTokenPayload {
  purpose: SubscriptionTokenPurpose;
  subscriptionId: string;
  address: string;
  email: string;
  nonce?: string | undefined;
  issuedAt: number;
  expiresAt: number;
}

export interface SubscriptionTokenServiceOptions {
  secret: string;
  now?: (() => number) | undefined;
}

export interface TokenInput {
  purpose: SubscriptionTokenPurpose;
  subscriptionId: string;
  address: string;
  email: string;
  ttlMs: number;
  nonce?: string | undefined;
}

export function createSubscriptionTokenService(options: SubscriptionTokenServiceOptions) {
  const now = options.now ?? Date.now;
  const consumedTokens = new Set<string>();

  return {
    sign(input: TokenInput): string {
      const issuedAt = now();
      const payload: SubscriptionTokenPayload = {
        purpose: input.purpose,
        subscriptionId: input.subscriptionId,
        address: input.address,
        email: input.email,
        nonce: input.nonce ?? randomBytes(16).toString('hex'),
        issuedAt,
        expiresAt: issuedAt + input.ttlMs,
      };

      return encodePayload(payload, options.secret);
    },

    verify(token: string): SubscriptionTokenPayload | null {
      return decodePayload(token, options.secret, now());
    },

    consume(token: string): SubscriptionTokenPayload | null {
      const payload = decodePayload(token, options.secret, now());
      if (!payload) {
        return null;
      }

      if (consumedTokens.has(token)) {
        return null;
      }

      consumedTokens.add(token);
      return payload;
    },

    isConsumed(token: string): boolean {
      return consumedTokens.has(token);
    },

    invalidate(token: string): void {
      consumedTokens.add(token);
    },
  };
}

function encodePayload(payload: SubscriptionTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodePayload(
  token: string,
  secret: string,
  now: number
): SubscriptionTokenPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) {
    return null;
  }

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (expectedBytes.length !== signatureBytes.length) {
    return null;
  }

  if (!timingSafeEqual(expectedBytes, signatureBytes)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SubscriptionTokenPayload;
    if (
      !parsed ||
      (parsed.purpose !== 'verify' && parsed.purpose !== 'unsubscribe') ||
      typeof parsed.subscriptionId !== 'string' ||
      typeof parsed.address !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number' ||
      (parsed.nonce !== undefined && typeof parsed.nonce !== 'string')
    ) {
      return null;
    }

    if (parsed.expiresAt < now) {
      return null;
    }

    if (parsed.issuedAt > now + 60_000) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
