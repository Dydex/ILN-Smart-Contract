import { describe, expect, it } from 'vitest';
import { signPayload } from '../src/delivery/signature';
import { createHmac, timingSafeEqual } from 'node:crypto';

// This acts as the external receiver verifying the signature based on docs
function externalReceiverVerify(secret: string, rawBody: string | Buffer, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

describe('Webhook HMAC signature End-to-End', () => {
  const secret = 'e2e_test_secret_key';
  const payload = JSON.stringify({
    event: 'invoice.paid',
    invoiceId: 42,
    data: { payer: 'GBBB...', token: 'USDC', amount: '1000000' },
    timestamp: '2025-12-03T00:00:00.000Z'
  });

  it('signs payload and independently verifies using the documented algorithm', () => {
    // 1. Generate signature using internal signing code
    const signature = signPayload(secret, payload);

    // 2. Independently verify the signature as an external receiver
    const isValid = externalReceiverVerify(secret, payload, signature);
    
    expect(isValid).toBe(true);
  });

  it('rejects a tampered payload', () => {
    // 1. Generate signature for original payload
    const signature = signPayload(secret, payload);

    // 2. Tamper the payload
    const tamperedPayload = payload.replace('1000000', '9000000');

    // 3. Verify tampered payload fails signature check
    const isValid = externalReceiverVerify(secret, tamperedPayload, signature);
    
    expect(isValid).toBe(false);
  });
});
