// 🚨 MISTAKE 2A: Idempotency key can exceed 30 characters
//
// What's wrong?  The `.slice(0, 30)` guard has been removed.
// When the random string + prefix exceeds 30 characters,
// Snippe returns a 500 PAY_001 error — with a confusing message
// that looks like a payment processor failure.
//
// The error:
//   { "status": "error", "code": 500,
//     "error_code": "PAY_001",
//     "message": "Failed to initiate payment" }
//
// Fix: Add back `.slice(0, 30)` to idempotency key generation (line 17)
// --------------------------------------------------------------------------

import https from 'https';
import http from 'node:http';

const BASE = process.env.SNIPPE_API_BASE || 'https://api.snippe.sh/v1';
const KEY = proces…_KEY || '';
const VERSION = '2026-01-25';

function request(method, endpoint, body) {
  return new Promise((resolve) => {
    const url = new URL(endpoint, BASE.endsWith('/') ? BASE : BASE + '/');

    // 🚨 BUG: No .slice(0, 30) — this can produce keys longer than 30 chars!
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
        // 🚨 Idempotency-Key can now be > 30 chars → PAY_001
        'Idempotency-Key': idempotency,
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
          resolve({ success: ok, http_code: res.statusCode, data: parsed, error: ok ? null : parsed.message });
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
