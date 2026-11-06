# API & Webhooks

The Example Cloud REST API and outbound webhooks let you automate workspaces, sync data, and react to events in near real time.

## Rate Limits by Tier

Every API key is subject to per-minute and daily rate limits that depend on the workspace plan.

| Plan       | Requests / minute      | Requests / day |
| ---------- | ---------------------- | -------------- |
| Starter    | 60                     | 10,000         |
| Growth     | 300                    | 100,000        |
| Enterprise | Custom (default 1,000) | Contractual    |

Rate-limit headers on every response:

- `X-RateLimit-Limit` — max requests in the current window
- `X-RateLimit-Remaining` — requests left
- `X-RateLimit-Reset` — Unix timestamp when the window resets

## 429 Too Many Requests & Retry-After

When a client exceeds its limit, the API returns HTTP **429 Too Many Requests**. The response body includes `"error": "rate_limit_exceeded"` and a `Retry-After` header with the number of seconds to wait.

### Recommended client behavior for 429

1. Read the `Retry-After` header (integer seconds).
2. Sleep for that duration (add a small jitter of 0–250 ms).
3. Retry the same request at most 3 times.
4. If 429 persists after retries, surface an error to the user and check the dashboard for unexpected traffic spikes.

Do not busy-loop without honoring `Retry-After`; aggressive retries can extend the lockout window.

## Webhook HMAC Signature Verification (X-Hub-Signature-256)

Outbound webhooks are signed so receivers can verify authenticity. Every delivery includes the header **`X-Hub-Signature-256`**.

### How the signature is computed

Example Cloud computes `HMAC-SHA256` over the raw request body using your workspace webhook secret, then prefixes the hex digest with `sha256=`. Example header value:

```
X-Hub-Signature-256: sha256=f7bc83f430538424b13298e6aa6ad1b1e0c5e0c5e0c5e0c5e0c5e0c5e0c5e0c5
```

### Verifying on your server

1. Read the raw body bytes (do not re-serialize JSON first).
2. Compute `HMAC-SHA256(webhook_secret, raw_body)` and hex-encode it.
3. Compare `sha256=` + your digest to the `X-Hub-Signature-256` header using a constant-time comparison.
4. Reject the request with HTTP 401 if they do not match.

Rotate the webhook secret under **Settings → Developers → Webhooks** if it may have leaked. After rotation, update verifiers within 15 minutes; dual-secret verification is supported during that window.

## Webhook Retry Backoff

If your endpoint returns a non-2xx status or times out (10 s), Example Cloud retries the delivery with exponential backoff:

- Attempt 1: immediate
- Attempt 2: after 1 minute
- Attempt 3: after 5 minutes
- Attempt 4: after 30 minutes
- Attempt 5: after 2 hours

After five failed attempts the delivery is marked **dead** and appears in **Settings → Developers → Webhook logs**. You can click **Redeliver** manually. Successful 2xx responses stop the retry chain immediately.
