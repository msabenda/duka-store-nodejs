# Series 7 — Direct mobile money (Node.js)

Duka Store now keeps checkout in its own branded UI and calls `POST https://api.snippe.sh/v1/payments` with `payment_type: "mobile"`. The integer TZS amount is recalculated server-side from the cart. Accepted Tanzanian forms (`07…`, `06…`, `7…`, `6…`, `+255…`, `255…`, with common separators) normalize to `255XXXXXXXXX`.

The UI names M-Pesa, Airtel Money, Mixx by Yas, and Halotel. It deliberately sends **no network/provider field**, because the 2026-01-25 payment documentation does not document one. Payload metadata contains both `order_id` (attempt UUID) and `order_reference`.


## Integration file map (read this first)

> **Repository-relative paths below are exact and verified against the current implementation.** The production integration boundary is `server.js` + `snippe.js`. Everything else is supporting UI, demo persistence, configuration, or tests. There is **no sandbox**; local/mock success must never be presented as a real phone prompt.

### Required integration files

| Path | Exact symbols/routes | Why it matters; data in → data out | Responsibility |
|---|---|---|---|
| `server.js` | Exports `formatPhone(phone = '')` and `app`. Private integration helpers: `cartData`, `readJSON`, `writeJSON`, `readProcessedWebhookEvents`, `hasProcessedWebhookEvent`, `markProcessedWebhookEvent`, `csrfToken`, `csrf`, `auth`. Active routes: `GET /checkout`, `POST /checkout/mobile`, `GET /order/:ref`, `GET /dashboard`, `POST /webhooks/snippe` (alias `/webhook`). | Session cart, authenticated user, and checkout fields enter `POST /checkout/mobile`; a server-recalculated integer TZS order is persisted, then `snippe.createMobilePayment(...)` receives normalized customer/payment data. The response contributes `snippe_reference`, `snippe_expires_at`, `last_api_http_code`, and possibly failure data; the browser is redirected to `/order/:ref`. Raw webhook bytes plus headers enter `POST /webhooks/snippe` (alias `/webhook`); a verified, mapped event updates order status and returns JSON acknowledgement. | Server-derived amount; phone validation; auth/ownership; CSRF; persist-before-network; stable per-attempt idempotency key; keep 201 as `pending`; raw-body capture; mandatory secret; HMAC/timestamp verification; constant-time comparison; event-ID dedupe; reference correlation; allow-listed status mapping. |
| `snippe.js` | Exports `createMobilePayment({ amount, phoneNumber, customer, webhookUrl, metadata, idempotencyKey })`. Private `request(method, endpoint, body, idempotencyKey, base = BASE)`. Constants `BASE`, `KEY`, `VERSION`. | Receives validated integration data from `server.js`; sends `POST payments` relative to `SNIPPE_API_BASE` (default `https://api.snippe.sh/v1`) with bearer auth, `Snippe-Version: 2026-01-25`, `Idempotency-Key`, and documented mobile-payment JSON. Resolves `{ success, http_code, data, error }`; it does not throw for HTTP/network/timeout failures. | API secret stays server-side; integer amount guard; exact documented payload (no provider/network field); timeout/error normalization; caller must reuse the persisted key when retrying the same attempt. |

### Supporting files developers must inspect, but not copy as production infrastructure

| Class | Path(s) | Exact touchpoint and data flow |
|---|---|---|
| Checkout/status templates | `views/checkout.ejs`, `views/order.ejs`, `views/dashboard.ejs` | `checkout.ejs` posts `_csrf`, `customer_name`, `customer_email`, and `customer_phone` to `/checkout/mobile`; it names four networks but sends no network field. `order.ejs` receives `order`/`error` and displays pending/status, amount, customer, items, and Snippe reference. `dashboard.ejs` receives the authenticated user's `orders`. These are demo presentation views, not payment authority; never fulfill from displayed/redirect state. |
| Cart/catalog support | `views/cart.ejs`, `catalog.js` | `cart.ejs` links to `GET /checkout`. `catalog.js` exports `PRODUCTS` and `productById(id)`; `server.js` uses them in `cartData` to recalculate prices and totals instead of trusting posted amounts. |
| Demo JSON persistence | `data/orders.json`, `data/users.json`, runtime-created `data/webhook-events.json` | Orders hold attempts, stable idempotency keys, API references, and webhook-driven status. Users support demo auth. Webhook event IDs/payloads support replay dedupe. Synchronous flat files are teaching storage—not safe concurrent production storage; use transactional durable storage with unique constraints on attempt/idempotency and event ID. |
| Tests | `test/series7.test.js` | Imports exact export `formatPhone`; tests accepted/rejected Tanzanian numbers and the 25-character `duka-` idempotency-key construction. It does **not** currently integration-test checkout, API request headers/body, signatures, webhook replay, ownership, or CSRF; cover those before production. |
| Runtime/config | `package.json`, `package-lock.json`, `.gitignore`, `.env` (local, ignored) | `package.json` declares ESM and `start`, `dev`, `test`; lockfile pins dependencies. Environment reads are exact: `SNIPPE_API_KEY`, `SNIPPE_API_BASE`, `SNIPPE_WEBHOOK_SECRET`, `SESSION_SECRET`, `APP_URL`, `SNIPPE_WEBHOOK_URL`, `PORT`, `NODE_ENV`. `.gitignore` excludes `.env`; do not commit or teach with real credentials. `SNIPPE_WEBHOOK_URL` must be public HTTPS for real callbacks (or it falls back to public HTTPS `APP_URL`). |
| Hosted-checkout reference only | Comment blocks in `server.js` and `snippe.js` | Clearly inactive historical Sessions/`checkout_url` guidance. There is no hosted-session export or active route. Do not execute or teach it as the Series 7 runtime path. |

### Recommended reading order

1. `SERIES-7-README.md` (contract, lifecycle, and no-sandbox limits).
2. `server.js`: raw-body middleware → `cartData`/`formatPhone` → CSRF/auth → `GET /checkout` and `POST /checkout/mobile` → `POST /webhooks/snippe` (alias `/webhook`) → owned order/status routes.
3. `snippe.js`: `createMobilePayment` first, then private `request` and its exact headers/result shape.
4. `views/checkout.ejs`, then `views/order.ejs` and `views/dashboard.ejs`; treat UI messages as presentation, not proof of payment.
5. `data/orders.json` and runtime `data/webhook-events.json` schema/behavior, while explicitly planning a transactional replacement.
6. `test/series7.test.js`, then add/run integration coverage against a local mock. Read the hosted Sessions comments last, only to contrast the inactive alternative.

## Lifecycle and storage

Before the API call, `data/orders.json` receives a durable attempt with a stable 25-character idempotency key. Retries of that attempt must reuse that stored key (do not create a new attempt). The response stores Snippe `reference` and `expires_at`. HTTP 201 means initiation only and remains `pending`; only a valid signed webhook may authoritatively transition to `completed`, `failed`, `voided`, or `expired` (and may reaffirm `pending`). Event IDs are persisted for deduplication.

Order and status views require login and ownership. Checkout POST uses a session CSRF token. Webhooks require `SNIPPE_WEBHOOK_SECRET`, exact raw bytes, HMAC-SHA256 over `<timestamp>.<raw-body>`, constant-time comparison, and a five-minute timestamp window.

## Configuration and receiving a real development webhook

Copy `.env.example` to `.env` and set `SNIPPE_API_KEY`, `SNIPPE_WEBHOOK_SECRET`, and `SESSION_SECRET`. `SNIPPE_WEBHOOK_SECRET` is the signing secret configured/provided for this webhook in Snippe; it is not the API key. Never commit `.env`.

A real payment cannot call back to localhost. Start the app and expose it through a public HTTPS tunnel:

```bash
npm start
ngrok http 8002
```

If ngrok reports `https://abc123.ngrok-free.app`, configure the exact callback in both `.env` and the relevant Snippe webhook configuration:

```dotenv
SNIPPE_WEBHOOK_URL=https://abc123.ngrok-free.app/webhooks/snippe
SNIPPE_WEBHOOK_SECRET=the-matching-signing-secret
```

Restart the app after editing `.env`, then initiate a **real development payment**. `SNIPPE_WEBHOOK_URL` takes precedence over `APP_URL`; when omitted, the application derives `<APP_URL>/webhooks/snippe`. The legacy `/webhook` path is also accepted, but the configured URL must be public HTTPS and end in exactly `/webhooks/snippe` or `/webhook`. HTTP and localhost callbacks are rejected before the API request.

Watch the Node process and ngrok request inspector while completing the phone prompt. A valid delivery returns JSON with `status: "ok"`; retries return `duplicate`. A `401 forged/stale` means the signing secret, exact raw payload, signature headers, or clock freshness is wrong. `503 webhook_not_configured` means `SNIPPE_WEBHOOK_SECRET` is absent. A `404` usually means the callback path is wrong. A 2xx `ignored` response means authentication succeeded but the event/order mapping or completion amount/currency did not qualify for a state change.

The hosted Sessions implementation is retained only as a clearly labeled educational comment in `snippe.js`/`server.js`; it is not active.

## NO-SANDBOX testing

**There is currently no Snippe sandbox.** Do not promise that a real phone prompt will appear from local/mock testing.

1. Run `npm test`.
2. Point `SNIPPE_API_BASE` at a local mock HTTP server that records `POST /payments` and returns deterministic `201` JSON such as `{"data":{"reference":"pay_mock_001","expires_at":"2026-08-28T13:00:00Z"}}`.
3. Submit checkout and inspect the recorded request: mobile type, integer TZS, normalized phone, customer, webhook URL, metadata, and stable `Idempotency-Key`.
4. Simulate a webhook using the exact JSON bytes. Set the current Unix-seconds timestamp and compute hex HMAC-SHA256 of `<timestamp>.<exact JSON>` using `SNIPPE_WEBHOOK_SECRET`; send the documented timestamp/signature headers. Verify one state transition and that replaying the same event ID returns `duplicate`.
5. Also test wrong signature, stale timestamp, unknown order, and terminal statuses.

Documentation gap: the reviewed 2026-01-25 material does not define a network-selection request field or provide a sandbox/test-phone contract. Mock testing validates the integration mechanics only; end-to-end callback behavior must be validated with a real development payment and a public HTTPS callback.
