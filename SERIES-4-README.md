# SERIES 4 - Webhooks & Event Handling (Node.js / Express)

> Real-time notifications are the heartbeat of a payment system. Snippe sends you an HTTP webhook when a payment or payout changes state, and your job is to verify the request, acknowledge it fast, and reconcile it back to your order ledger.

## What You Will Learn

- How to expose a secure webhook endpoint in Express
- How to test the endpoint locally with ngrok or a public tunnel
- Which Snippe event types matter for a store like Duka Store
- How to verify the HMAC signature using the raw request body
- Why the response must be fast and why the processing should move async
- How retries and duplicate deliveries work in practice
- How to reconcile a webhook event with your order using metadata and reference

## Why Webhooks Matter

The redirect URL is helpful, but it is not proof of payment.

Your source of truth is the event payload sent by Snippe.

```text
Customer pays on Snippe hosted checkout
        ↓
Snippe fires webhook: payment.completed
        ↓
Express verifies the HMAC signature
        ↓
Order is updated to completed
        ↓
Success page shows the real order status
```

## The Endpoint

This app exposes the incoming Webhook on:

- `/webhook`

The route is intentionally outside the browser form flow, so CSRF is not applied.

See:

- `server.js`

## Local Testing with ngrok

```bash
npm start
# in another terminal
ngrok http 8002
```

Then set:

```env
APP_URL=https://your-ngrok-url
SNIPPE_WEBHOOK_SECRET=whsec_your_secret_here
```

Use that HTTPS URL as the `webhook_url` when creating the payment session.

## Event Types the Store Cares About

For a Duka Store, the important events are:

- `payment.completed`
- `payment.failed`
- `payment.cancelled`
- `payment.expired`
- payout events if you operate a merchant or disbursement flow

The handler maps these to logical order values:

```js
const statusMap = {
  'payment.completed': 'completed',
  'payment.successful': 'completed',
  'payment.failed': 'failed',
  'payment.cancelled': 'cancelled',
  'payment.expired': 'expired',
};
```

## Signature Verification Is Non-Negotiable

Snippe signs each webhook with the raw request body plus the timestamp.

The documented contract is:

```text
message = "{timestamp}.{raw_body}"
signature = HMAC-SHA256(signing_key, message)
```

The Node.js implementation verifies it with:

```js
const payloadText = raw.toString('utf-8');
const computed = crypto.createHmac('sha256', secret)
  .update(`${timestamp}.${payloadText}`)
  .digest('hex');

const normalized = signature.trim().replace(/^sha256\s*=\s*/i, '').toLowerCase();
const expected = computed.toLowerCase();

if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
  return res.status(401).json({ status: 'forged' });
}
```

This prevents a forged payload from updating your order.

## Raw Body, Not Re-serialized JSON

Do not parse and re-serialize the payload before checking the HMAC.

This breaks the signature because even a small whitespace change invalidates the computed value.

Use the raw buffer as captured by Express:

```js
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
```

## Fast Response, Async Processing

The docs recommend returning `2xx` quickly and processing work asynchronously.

In practice, you should do:

1. verify the signature
2. return `200 OK`
3. queue the follow-up business logic

This is important because Snippe retries failed webhook deliveries automatically.

## Retry and Duplicate Behavior

Snippe retries a webhook with exponential backoff if the endpoint returns a non-2xx or times out.

This means you should assume:

- the same event can show up again
- a previous request may be retried after a timeout
- your logic must be idempotent

The Node.js app stores processed event IDs and ignores duplicates.

## Reconciliation: Event + Reference = Ledger

The heart of the integration is the order reference.

When creating the session, this project sends:

```js
const metadata = { order_reference: reference, source: 'duka-store-nodejs' };
```

Then the webhook handler resolves the order by checking:

- `metadata.order_reference`
- `data.metadata.order_reference`
- `data.reference`
- `data.external_reference`
- `data.description` containing a `DUKA-...` reference

That is the ledger rule: the event tells you what happened, and the reference tells you which order it belongs to.

## Production Checklist

- [ ] `SNIPPE_WEBHOOK_SECRET` is in environment variables or a secret manager
- [ ] The endpoint uses HTTPS
- [ ] The app verifies the raw request body and signature
- [ ] The timestamp is checked for freshness
- [ ] The webhook returns `2xx` immediately
- [ ] Duplicate events are ignored by `event_id`
- [ ] The UI is driven by your order ledger, not the redirect alone

## Key Files

- `server.js` — checkout routes and webhook handler
- `snippe.js` — raw HTTP calls to Snippe
- `data/orders.json` — local ledger of orders
- `.env` — Snippe config and app URL

## Next Step

The natural next upgrade is to move webhook processing behind a queue worker so the API can respond immediately while you process payments, send emails, or reconcile inventory asynchronously.
