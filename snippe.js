import https from 'https';
import http from 'node:http';

// Snippe has two API bases:
// - https://api.snippe.sh/v1      → POST /payments (payments endpoint).
//   Used by the custom checkout flow (mobile/card/QR) - kept for future use.
// - https://api.snippe.sh/api/v1  → POST /sessions (checkout session creation
//   for the hosted checkout). This is the base used by the current checkout.
const BASE = process.env.SNIPPE_API_BASE || 'https://api.snippe.sh/v1';
const SESSIONS_BASE = process.env.SNIPPE_API_BASE_SESSIONS || 'https://api.snippe.sh/api/v1';
const KEY = process.env.SNIPPE_API_KEY || '';
const VERSION = '2026-01-25';

function request(method, endpoint, body, base = BASE) {
  return new Promise((resolve) => {
    const url = new URL(endpoint, base.endsWith('/') ? base : base + '/');
    const idempotency = 'duka_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      port: url.port,
      method,
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Snippe-Version': VERSION,
        'User-Agent': 'duka-store-nodejs/1.0.0',
        'Idempotency-Key': idempotency.slice(0, 30),
      },
      timeout: 30000,
    };

    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          // Pull the API's own error message out of common response shapes so
          // the UI shows the real reason instead of a generic fallback.
          let apiError = null;
          if (!ok && parsed) {
            apiError = parsed.message
              || (typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message || null))
              || parsed.detail
              || parsed.data?.message
              || null;
          }
          resolve({ success: ok, http_code: res.statusCode, data: parsed, error: apiError });
        } catch {
          resolve({ success: false, http_code: res.statusCode, data: null, error: raw });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, http_code: 0, data: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, http_code: 0, data: null, error: 'Request timed out' }); });

    if (data) req.write(data);
    req.end();
  });
}

// ── /v1 payments endpoint (SNIPPE_API_BASE = https://api.snippe.sh/v1) ──
// The three payment functions below power the custom checkout form flow
// (mobile / card / QR) - currently disabled in this demo. Kept for future use.
export function createMobilePayment(amount, currency, phoneNumber, customer, webhookUrl, metadata) {
  const payload = {
    payment_type: 'mobile',
    details: { amount, currency },
    phone_number: phoneNumber,
    customer: { firstname: customer.firstname || '', lastname: customer.lastname || '', email: customer.email || '' },
  };
  if (webhookUrl) payload.webhook_url = webhookUrl;
  if (metadata) payload.metadata = metadata;
  return request('POST', 'payments', payload);
}

// 🎙️ DA NOTE — HOSTED CHECKOUT / PAYMENT SESSIONS (Session 3)
// This is the "create session" step: ask Snippe for a hosted checkout and it
// returns a payment_url (the Sessions API calls it checkout_url) to send the
// customer to. `details.redirect_url` / `details.cancel_url` bring them back
// to your site; `webhook_url` is where the status update lands; `metadata` is
// your reconciliation key. Same shape across all three demo frameworks.
// Docs: https://docs.snippe.sh/docs/2026-01-25/sessions
//       https://docs.snippe.sh/docs/2026-01-25/sessions/profiles       (branding via profile_id)
//       https://docs.snippe.sh/docs/2026-01-25/sessions/payment-links  (short shareable links)
export function createCardPayment(amount, currency, redirectUrl, cancelUrl, customer, phoneNumber, webhookUrl, metadata) {
  const payload = {
    payment_type: 'card',
    details: { amount, currency, redirect_url: redirectUrl, cancel_url: cancelUrl },
    customer: {
      firstname: customer.firstname || '', lastname: customer.lastname || '', email: customer.email || '',
      address: customer.address || '', city: customer.city || '', state: customer.state || '',
      postcode: customer.postcode || '', country: customer.country || 'TZ',
    },
  };
  if (phoneNumber) payload.phone_number = phoneNumber;
  if (webhookUrl) payload.webhook_url = webhookUrl;
  if (metadata) payload.metadata = metadata;
  return request('POST', 'payments', payload);
}

export function createQrPayment(amount, currency, customer, redirectUrl, cancelUrl, phoneNumber, webhookUrl, metadata) {
  const payload = {
    payment_type: 'dynamic-qr',
    details: { amount, currency },
    customer: { firstname: customer.firstname || '', lastname: customer.lastname || '', email: customer.email || '' },
  };
  if (redirectUrl) payload.details.redirect_url = redirectUrl;
  if (cancelUrl) payload.details.cancel_url = cancelUrl;
  if (phoneNumber) payload.phone_number = phoneNumber;
  if (webhookUrl) payload.webhook_url = webhookUrl;
  if (metadata) payload.metadata = metadata;
  return request('POST', 'payments', payload);
}

// 🎙️ DA NOTE — PAYMENT SESSIONS / HOSTED CHECKOUT (Series 3): creates a hosted
// checkout session. The response's checkout_url is the Snippe page the customer
// is redirected to — they fill/confirm their details and pay there (mobile
// money). metadata.order_reference is how the webhook reconciles the payment.
// Docs: https://docs.snippe.sh/docs/2026-01-25/sessions
//       https://docs.snippe.sh/docs/2026-01-25/sessions/payment-links
//       https://docs.snippe.sh/docs/2026-01-25/sessions/profiles
// NOTE: sessions live on the /api/v1 base, NOT the /v1 payments base (see the
// two bases at the top of this file).
//
// Request body fields (per the docs):
//   amount (min 500; suggested amount when allow_custom_amount is true)
//   currency (ISO 4217, only TZS)
//   customer (pre-fills checkout form: name, email, phone)
//   redirect_url (where to send the customer after payment, max 500 chars)
//   webhook_url (receives payment events, max 500 chars)
//   metadata (max 50 keys - reconciliation data)
//   description (max 500 chars)
//   allowed_methods (default ["mobile_money"])
//   expires_in (default 3600s, range 60-86400)
//   allow_custom_amount / min_amount / max_amount (customer-entered amount)
//   profile_id (payment profile for branding, dashboard-managed)
//   line_items (max 50, display-only)
//   custom_fields (max 20 fields)
//   display (checkout UI settings)
export function createSession({ amount, currency = 'TZS', customer, redirect_url, webhook_url, metadata, description, allowed_methods, expires_in, allow_custom_amount, min_amount, max_amount, profile_id, line_items, custom_fields, display }) {
  const payload = { amount, currency };
  if (allowed_methods) payload.allowed_methods = allowed_methods;
  if (allow_custom_amount !== undefined) payload.allow_custom_amount = allow_custom_amount;
  if (min_amount !== undefined) payload.min_amount = min_amount;
  if (max_amount !== undefined) payload.max_amount = max_amount;
  if (customer) payload.customer = customer;
  if (profile_id) payload.profile_id = profile_id;
  if (redirect_url) payload.redirect_url = redirect_url;
  if (webhook_url) payload.webhook_url = webhook_url;
  if (description) payload.description = description;
  if (metadata) payload.metadata = metadata;
  if (expires_in) payload.expires_in = expires_in;
  if (line_items) payload.line_items = line_items;
  if (custom_fields) payload.custom_fields = custom_fields;
  if (display) payload.display = display;
  return request('POST', 'sessions', payload, SESSIONS_BASE);
}
