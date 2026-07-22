# Duka Store - Snippe Payment Integration (Node.js / Express)

An Express.js store that collects payments via **Mobile Money**, **Cards**, and **QR Codes** using the Snippe Payments API. Raw HTTP calls, no SDK.

Use this as a reference when integrating Snippe into any Node.js or JavaScript project.

---

## Quick Start

```bash
cp .env.example .env        # or edit .env directly
npm install
npm start
# → http://localhost:8002
```

Set these in `.env`:

```
SNIPPE_API_KEY=***
APP_URL=https://your-domain.com      # Must be HTTPS - Snippe sends webhooks here
SESSION_SECRET=***      # Anything random, for session cookies
```

> **For local testing:** run `ngrok http 8002`, copy the HTTPS URL, and set `APP_URL` to it.
> Snippe requires a reachable HTTPS webhook URL.

---

## Integration Points

There are exactly **four** places where your Node.js app talks to Snippe.

| # | File | What it does |
|---|---|---|
| 1 | `server.js` (top) | Reads config from `.env` via `process.env` |
| 2 | `snippe.js` | Raw HTTP calls to Snippe |
| 3 | `server.js` (`processPayment`) | Creates payments and redirects customers |
| 4 | `server.js` (`POST /webhook`) | Handles async payment status updates |

---

## 1. Configuration - `.env`

```
SNIPPE_API_KEY=***
SNIPPE_API_BASE=https://api.snippe.sh/v1
SNIPPE_WEBHOOK_SECRET=
APP_URL=https://your-domain.com
```

Every API call sends these headers automatically (set in `snippe.js`):

| Header | Value |
|---|---|
| `Authorization` | `Bearer {api_key}` |
| `Snippe-Version` | `2026-01-25` |
| `Idempotency-Key` | Unique per request (≤ 30 chars) |
| `Content-Type` | `application/json` |

---

## 2. Accepting Payments - `POST /v1/payments`

There are three payment types. Each one maps to a different API call.

### Mobile Money

Customer gets a USSD push on their phone.

```javascript
const response = await fetch('https://api.snippe.sh/v1/payments', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.SNIPPE_API_KEY}`,
    'Snippe-Version': '2026-01-25',
    'Idempotency-Key': `order_${Date.now()}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    payment_type: 'mobile',
    details: { amount: 500, currency: 'TZS' },
    phone_number: '255781000000',
    customer: {
      firstname: 'John',
      lastname: 'Doe',
      email: 'john@example.com',
    },
    webhook_url: 'https://your-domain.com/webhook',
    metadata: { order_reference: 'DUKA-ABC123' },
  }),
});
```

The USSD push is sent automatically. Customer enters their PIN on their phone to authorise.

**Required fields:**

| Field | Type | Description |
|---|---|---|
| `payment_type` | string | Must be `"mobile"` |
| `details.amount` | integer | Amount in smallest unit (e.g. 500 = 500 TZS) |
| `details.currency` | string | `"TZS"` (Tanzanian Shilling - the only supported currency) |
| `phone_number` | string | Customer phone in international format (`255XXXXXXXXX`) |
| `customer.firstname` | string | Customer's first name |
| `customer.lastname` | string | Customer's last name |
| `customer.email` | string | Customer's email address |

**Optional fields:** `webhook_url`, `metadata`

---

### Card Payment

Customer is redirected to a secure hosted checkout page.

```javascript
const response = await fetch('https://api.snippe.sh/v1/payments', {
  method: 'POST',
  headers: { /* same headers */ },
  body: JSON.stringify({
    payment_type: 'card',
    details: {
      amount: 500,
      currency: 'TZS',
      redirect_url: 'https://your-domain.com/order/success/DUKA-ABC123',
      cancel_url: 'https://your-domain.com/order/cancelled',
    },
    customer: {
      firstname: 'John',
      lastname: 'Doe',
      email: 'john@example.com',
      address: '123 Main St',
      city: 'Dar es Salaam',
      state: 'DSM',
      postcode: '14101',
      country: 'TZ',
    },
    webhook_url: 'https://your-domain.com/webhook',
  }),
});
```

**Response:**

```json
{
  "status": "success",
  "code": 201,
  "data": {
    "reference": "2e0bcc5f-92ca-44f9-8c1b-4d2966d9921f",
    "status": "pending",
    "payment_url": "https://tz.selcom.online/paymentgw/checkout/...",
    "amount": { "currency": "TZS", "value": 500 }
  }
}
```

**Your next step:** Redirect the customer to `payment_url`. Snippe handles card entry, 3D Secure, and confirmation.

---

### Dynamic QR

Generates a QR code the customer scans with their mobile money app.

```javascript
const response = await fetch('https://api.snippe.sh/v1/payments', {
  method: 'POST',
  headers: { /* same headers */ },
  body: JSON.stringify({
    payment_type: 'dynamic-qr',
    details: { amount: 500, currency: 'TZS' },
    customer: {
      firstname: 'John',
      lastname: 'Doe',
      email: 'john@example.com',
    },
    webhook_url: 'https://your-domain.com/webhook',
  }),
});
```

**Response data includes:**
- `payment_url` - hosted checkout page to redirect the customer to
- `payment_qr_code` - QR data string to render as a scannable image for in-person payments
- `reference` - unique payment reference
- `payment_token` - payment token for reference

**Your next step:** Either redirect to `payment_url` or render `payment_qr_code` as a QR image.

---

## 3. The Webhook - Your App Gets Notified

After payment, Snippe sends a `POST` to your `webhook_url`. This is how your app learns the final status without polling.

**Your webhook endpoint (in your Express app):**

```javascript
app.post('/webhook', (req, res) => {
  const payload = req.body;
  const raw = JSON.stringify(payload);

  // Verify signature (optional but recommended)
  const secret = process.env.SNIPPE_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['snippe-signature'];
    const expected = 'sha256=' +
      crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return res.status(401).json({ status: 'forged' });
    }
  }

  const event = payload.event || payload.type;
  const reference = payload.reference;

  const statusMap = {
    'payment.completed': 'completed',
    'payment.failed': 'failed',
    'payment.cancelled': 'cancelled',
    'payment.expired': 'expired',
  };

  const newStatus = statusMap[event];
  if (newStatus && reference) {
    // Update your order in the database
    db.collection('orders').updateOne(
      { reference },
      { $set: { status: newStatus } }
    );
  }

  res.json({ status: 'ok' });
});
```

**Events you should handle:**

| Event | Meaning |
|---|---|
| `payment.completed` | Payment succeeded, funds settled |
| `payment.failed` | Payment declined or timed out |
| `payment.cancelled` | Customer cancelled before completing |
| `payment.expired` | 4-hour expiry window passed |

---

## 4. Important Rules

### Idempotency Keys

Always send an `Idempotency-Key` header with every `POST /v1/payments`.

- **Max 30 characters** - longer keys return a 500 error
- **Same key + same body** = returns cached response (safe to retry)
- **Same key + different body** = returns error
- Keys are valid for **24 hours**

```javascript
// Good
headers['Idempotency-Key'] = 'order-abc123-retry-1';       // ≤ 30 chars ✓

// Bad - will fail
headers['Idempotency-Key'] = `order-${orderId}-${Date.now()}`;  // likely too long ✗
```

### Webhook URL must be HTTPS and reachable

Snippe will reject webhook URLs that are `localhost`, `127.0.0.1`, or HTTP.

```javascript
const baseUrl = (process.env.APP_URL || 'http://localhost:8002')
  .replace('http://', 'https://');
const webhookUrl = `${baseUrl}/webhook`;
```

### Minimum amount

The minimum payment amount is **500 TZS** (5 smallest units).

### Payments expire after 4 hours

Create a fresh payment if the customer wants to retry.

---

## Common Issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `webhook_url localhost URLs are not allowed` | Webhook URL pointing to localhost | Use `APP_URL` with your ngrok/domain |
| `webhook URL must use HTTPS` | `APP_URL` has `http://` | Replace `http://` with `https://` |
| `invalid or missing API key` | Wrong or missing `SNIPPE_API_KEY` | Check your key in the dashboard |
| USSD push never arrives | Webhook URL not reachable | Use ngrok in dev, set `APP_URL` |
| `amount is required` | Wrong field name | Use `details.amount`, not top-level `amount` |
| 500 error on create | Idempotency key too long | Keep it under 30 characters |

---

## Files That Matter

```
duka-store-nodejs/
│
├── .env                 ← SNIPPE_API_KEY, APP_URL
├── server.js            ← Payment creation + webhook handler
└── snippe.js            ← All HTTP calls to Snippe
```
