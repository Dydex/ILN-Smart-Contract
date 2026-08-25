import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSubscriptionTokenService, type SubscriptionTokenPayload } from '../src/subscriptions/emailToken';

function encode(payload: SubscriptionTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('createSubscriptionTokenService', () => {
  it('signs and verifies tokens', () => {
    const now = 1_700_000_000_000;
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => now,
    });

    const token = svc.sign({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    const payload = svc.verify(token);
    expect(payload).toMatchObject({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      issuedAt: now,
      expiresAt: now + 60_000,
    });
  });

  it('returns null for malformed or tampered tokens', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    expect(svc.verify('malformed-token')).toBeNull();
    expect(svc.verify('body.only')).toBeNull();
    expect(
      svc.verify(
        encode(
          {
            purpose: 'verify',
            subscriptionId: 'sub_1',
            address: 'GABC123',
            email: 'user@example.com',
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_060_000,
          },
          'wrong-secret',
        ),
      ),
    ).toBeNull();
  });

  it('returns null for expired or unsupported-purpose tokens', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    const expired = svc.sign({
      purpose: 'unsubscribe',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: -1,
    });
    expect(svc.verify(expired)).toBeNull();

    const unsupportedPurpose = encode(
      {
        purpose: 'verify' as any,
        subscriptionId: 'sub_1',
        address: 'GABC123',
        email: 'user@example.com',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
      },
      'test-secret',
    );
    const body = unsupportedPurpose.split('.')[0];
    const tamperedBody = Buffer.from(
      JSON.stringify({
        purpose: 'unknown',
        subscriptionId: 'sub_1',
        address: 'GABC123',
        email: 'user@example.com',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
      }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', 'test-secret').update(tamperedBody).digest('base64url');
    expect(svc.verify(`${tamperedBody}.${signature}`)).toBeNull();
    expect(body).toBeTruthy();
  });

  it('guarantees token uniqueness across 1,000 generations with identical inputs (entropy audit)', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = svc.sign({
        purpose: 'verify',
        subscriptionId: 'sub_same_id',
        address: 'GABC123',
        email: 'user@example.com',
        ttlMs: 60_000,
      });
      tokens.add(token);
    }

    expect(tokens.size).toBe(1000);
  });

  it('enforces single-use token consumption and prevents replay', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    const token = svc.sign({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    expect(svc.isConsumed(token)).toBe(false);

    const firstAttempt = svc.consume(token);
    expect(firstAttempt).not.toBeNull();
    expect(firstAttempt?.subscriptionId).toBe('sub_1');
    expect(svc.isConsumed(token)).toBe(true);

    const replayAttempt = svc.consume(token);
    expect(replayAttempt).toBeNull();
  });

  it('rejects tokens claiming to be issued far in the future (clock skew protection)', () => {
    const now = 1_700_000_000_000;
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => now,
    });

    const futureToken = encode(
      {
        purpose: 'verify',
        subscriptionId: 'sub_1',
        address: 'GABC123',
        email: 'user@example.com',
        issuedAt: now + 120_000,
        expiresAt: now + 180_000,
      },
      'test-secret',
    );

    expect(svc.verify(futureToken)).toBeNull();
    expect(svc.consume(futureToken)).toBeNull();
  });

  it('supports explicit token invalidation', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    const token = svc.sign({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    svc.invalidate(token);
    expect(svc.isConsumed(token)).toBe(true);
    expect(svc.consume(token)).toBeNull();
  });
});

