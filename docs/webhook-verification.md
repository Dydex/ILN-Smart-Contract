# Webhook HMAC Signature Verification

The Invoice Liquidity Network notifications service signs all webhook payloads with HMAC-SHA256 to ensure data integrity and authenticity. Integrators should verify these signatures before processing any webhook events.

## Verifying the HMAC signature

The `x-iln-signature` header contains the `HMAC-SHA256` of the **exact raw request body bytes**, keyed by the subscription's `secret`, encoded as lowercase hex. 

Always follow these steps:
1. Read the **raw** body bytes — verify **before** JSON parsing/re-serialising, because re-serialisation can change the bytes and break the signature.
2. Use a **constant-time** comparison to avoid timing attacks.

### TypeScript / Node.js

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Express: capture the raw body so the signed bytes are preserved.
import express from 'express';
const app = express();
app.post(
  '/hooks/iln',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.header('x-iln-signature') ?? '';
    if (!verifySignature(process.env.ILN_WEBHOOK_SECRET!, req.body, signature)) {
      return res.status(401).send('bad signature');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    // ... handle event ...
    res.sendStatus(200);
  },
);
```

### Python

```python
import hmac
import hashlib

def verify_signature(secret: str, raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    # constant-time comparison
    return hmac.compare_digest(expected, signature)

# Flask example
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/hooks/iln")
def hook():
    signature = request.headers.get("x-iln-signature", "")
    if not verify_signature(SECRET, request.get_data(), signature):
        abort(401)
    event = request.get_json()
    # ... handle event ...
    return "", 200
```

### Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
)

func verifySignature(secret string, body []byte, signature string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	// constant-time comparison
	return hmac.Equal([]byte(expected), []byte(signature))
}

func handler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		if !verifySignature(secret, body, r.Header.Get("x-iln-signature")) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		// ... json.Unmarshal(body, &event); handle ...
		w.WriteHeader(http.StatusOK)
	}
}
```
