# SERIES 3 - Hosted Checkout with Payment Sessions (Node.js / Express)

> Snippe demo series. Learn how to accept a real payment in minutes:
> create a payment session, redirect your customer to Snippe's hosted checkout,
> and bring them back to your site - with the webhook as the source of truth.
> This project is the working reference implementation: raw HTTP, no SDK.

## What You Will Learn

- The Payment Sessions flow: create session -> redirect -> return URL
- What belongs in a session (amount, currency, customer, reference, metadata) and why the reference matters
- How the return redirect works after the customer pays on Snippe's page
- Why the redirect is NOT proof of payment (and what to trust instead)
- Why you should create exactly one session per checkout intent

## How the Flow Works

```
 YOUR store            Snippe API               Snippe hosted page
 /checkout      --->   create session    --->   customer fills details + pays
     ^                 (POST /api/v1/sessions)        |
     |                                                | paid
     |                                                v
     +--- redirect_url ------------------>  Back on YOUR site: /order/{ref}
                                             status = pending (redirect is not proof)
     ^
     |
     +--- webhook (payment.completed) flips order to completed
          (the source of truth)
```

Four moves: create session, redirect, customer pays, customer returns. Your
server never touches card details - and the customer's details are filled in on
Snippe's hosted page, not on yours.

## Prerequisites

- Node.js 18+ and npm
- A Snippe account and API key (`SNIPPE_API_KEY`)
- A public HTTPS URL for local testing (ngrok or a deployed domain)

```bash
npm install
# edit .env: set SNIPPE_API_KEY and APP_URL (https)
npm start                   # http://localhost:8002
```

Optional base URL overrides (defaults are correct for most accounts):

```
SNIPPE_API_BASE_SESSIONS=https://api.snippe.sh/api/v1   # POST /sessions (used now)
SNIPPE_API_BASE=https://api.snippe.sh/v1                # POST /payments (future use)
```

For local testing, expose the app:

```bash
ngrok http 8002
```

Copy the `https://...` URL into `APP_URL` in `.env`. Snippe requires HTTPS for
redirect and webhook URLs - it rejects `localhost` and plain HTTP.

## Try It: Your First Payment

1. Open the store at http://localhost:8002 and register an account. The form
   collects a phone number - Snippe uses it to pre-fill the hosted checkout.
2. Add a couple of products to the cart (every product is 500 TZS).
3. Click **Checkout** - there is no payment form on your site: the app creates
   a session and sends you straight to Snippe's hosted checkout.
4. Open DevTools (Network tab) before clicking Checkout. You will see the
   `POST /api/v1/sessions` request and the `checkout_url` in the response.
5. You land on Snippe's hosted checkout page. Your name, email and phone are
   pre-filled from your account - confirm or edit them, then pay with mobile money.
6. After paying you return to your site at `/order/{reference}`. Notice the
   order status: it is `pending`. The payment confirmation arrives separately
   (webhook) - see the status flip to `completed` on refresh.

## Key Integration Files (in this repo)

| # | File | What it does |
|---|---|---|
| 1 | `server.js` - `POST /checkout/pay` | Creates the session from the cart + logged-in user, redirects to `checkout_url` |
| 2 | `snippe.js` - `createSession()` | Raw HTTP call to `POST /api/v1/sessions` (headers, idempotency key) |
| 3 | `server.js` - `POST /webhook` | Receives the async status update, reconciles by `metadata.order_reference` |
| 4 | `views/register.ejs` | Collects the phone number used to pre-fill the hosted checkout |

There are **two Snippe API bases** (both documented at the top of `snippe.js`):

- `https://api.snippe.sh/api/v1` - `POST /sessions` (checkout session creation; used here)
- `https://api.snippe.sh/v1` - `POST /payments` (payments endpoint; kept for the custom checkout form flow)

## What Belongs in a Session

| Field | Value in this store | Why it matters |
|---|---|---|
| `amount` | Cart total (TZS) | What the customer pays (minimum 500) |
| `currency` | `TZS` | The supported currency |
| `customer` | name / email / phone | Pre-fills the hosted checkout form (editable) |
| `redirect_url` | `APP_URL/order/{reference}` | Where the customer lands after paying |
| `webhook_url` | `APP_URL/webhook` | Where the status update is sent |
| `metadata` | `{ order_reference, source }` | **Your reconciliation key** |
| `description` | `Duka Store order {reference}` | Shown on the checkout page |

**The reference is the glue.** The order reference (`DUKA-...`) is baked into
the `redirect_url` and the metadata. When the webhook arrives, the app resolves
the order by that reference - no phone lookup, no guessing. Snippe echoes
metadata back in every webhook payload, so you can match payments to your
internal records.

## The Return Redirect

A session has a single `redirect_url` - after the customer pays (or cancels) on
the hosted page, Snippe sends them back there. This store points it at
`/order/{reference}`, and the order status tells the story. That is fine for a
demo; in production you may want a distinct page for cancelled sessions. The
important part: the route exists on your server, so the customer always comes
back to your site.

## The Redirect Is Not Proof of Payment

Landing on `redirect_url` only means the customer *visited* the hosted checkout.
Anyone can hit that URL - it proves nothing about the payment. The order stays
`pending` until the webhook confirms it and flips it to `completed`.

Never ship redirect-only confirmation. Use the webhook as the source of truth.

## One Session per Checkout Intent

Notice that the cart is cleared immediately after the session is created
(`req.session.cart = []`). One checkout intent should produce one session. Do
not re-create sessions on every retry or page reload - repeated session
creation is an abuse signal, and Snippe tracks it.

## Going Further

| Topic | Doc | Notes |
|---|---|---|
| Payment Sessions | [docs/sessions](https://docs.snippe.sh/docs/2026-01-25/sessions) | Create session, `checkout_url`, statuses: `pending` -> `active` -> `completed` / `expired` / `cancelled` |
| Payment Profiles | [docs/sessions/profiles](https://docs.snippe.sh/docs/2026-01-25/sessions/profiles) | Brand the checkout with `profile_id` (logo, colors, locale) - managed in the dashboard |
| Payment Links | [docs/sessions/payment-links](https://docs.snippe.sh/docs/2026-01-25/sessions/payment-links) | Short `payment_link_url` for SMS/WhatsApp; `?meta=` makes a link programmable (base64, not encrypted - no secrets) |

The `/v1` payments functions (`createMobilePayment()`, `createCardPayment()`,
`createQrPayment()` in `snippe.js`) power the custom checkout form flow -
currently disabled, kept for later.

## Common Pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| 404 when creating a session | Wrong API base | Sessions live on `/api/v1` - set `SNIPPE_API_BASE_SESSIONS=https://api.snippe.sh/api/v1` |
| `webhook_url localhost URLs are not allowed` | URL points at localhost | Use `APP_URL` with your ngrok/domain |
| `webhook URL must use HTTPS` | `APP_URL` has `http://` | Set `APP_URL` with `https://` |
| `invalid or missing API key` | Wrong/missing `SNIPPE_API_KEY` | Check the Snippe dashboard |
| 500 error on create | Idempotency key too long | Keep it under 30 characters |
| Order stays `pending` forever | Webhook not delivered or not verified | Check webhook logs; set `SNIPPE_WEBHOOK_SECRET` in production |

## Next Steps

The webhook is the source of truth for payment status. Read the
[webhooks documentation](https://docs.snippe.sh/docs/2026-01-25/webhooks) to learn
how to verify signatures and reconcile orders server-side.
