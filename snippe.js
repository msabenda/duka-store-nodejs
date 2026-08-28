import https from 'https';
import http from 'node:http';

const BASE = process.env.SNIPPE_API_BASE || 'https://api.snippe.sh/v1';
const KEY = process.env.SNIPPE_API_KEY || '';
const VERSION = '2026-01-25';

function request(method, endpoint, body, idempotencyKey, base = BASE) {
  return new Promise((resolve) => {
    const url = new URL(endpoint, base.endsWith('/') ? base : base + '/');
    const data = JSON.stringify(body);
    const options = { hostname: url.hostname, path: url.pathname, port: url.port, method, headers: {
      Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'Snippe-Version': VERSION, 'User-Agent': 'duka-store-nodejs/1.0.0', 'Idempotency-Key': idempotencyKey,
      'Content-Length': Buffer.byteLength(data),
    }, timeout: 30000 };
    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        const success = res.statusCode >= 200 && res.statusCode < 300;
        const error = success ? null : parsed?.message || parsed?.error?.message || parsed?.error || parsed?.detail || raw || `HTTP ${res.statusCode}`;
        resolve({ success, http_code: res.statusCode, data: parsed, error });
      });
    });
    req.on('error', e => resolve({ success: false, http_code: 0, data: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, http_code: 0, data: null, error: 'Request timed out' }); });
    req.end(data);
  });
}

/** Direct first-party mobile-money payment. No undocumented network/provider field. */
export function createMobilePayment({ amount, phoneNumber, customer, webhookUrl, metadata, idempotencyKey }) {
  if (!Number.isInteger(amount)) throw new TypeError('amount must be an integer TZS value');
  return request('POST', 'payments', {
    payment_type: 'mobile', details: { amount, currency: 'TZS' }, phone_number: phoneNumber,
    customer: { firstname: customer.firstname || '', lastname: customer.lastname || '', email: customer.email || '' },
    webhook_url: webhookUrl, metadata,
  }, idempotencyKey);
}

/* EDUCATIONAL REFERENCE ONLY — hosted Sessions flow (not active).
Docs: https://docs.snippe.sh/docs/2026-01-25/sessions
Historically this app POSTed session data to /api/v1/sessions and redirected to
checkout_url. Series 7 intentionally uses the direct /v1/payments flow above so
the Duka-branded checkout remains first-party. Do not call this reference code.
*/
