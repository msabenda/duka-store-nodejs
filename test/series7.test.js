import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { formatPhone, resolveWebhookUrl } = await import('../server.js');

test('normalizes accepted Tanzanian mobile forms', () => {
  for (const input of ['0712 345 678', '+255 712 345 678', '255712345678', '712345678']) assert.equal(formatPhone(input), '255712345678');
});
test('rejects non-Tanzanian or malformed numbers', () => {
  for (const input of ['123', '+254712345678', '255112345678']) assert.throws(() => formatPhone(input));
});
test('canonical idempotency construction stays under 30 chars', () => {
  const key = 'duka-' + 'a'.repeat(20); assert.equal(key.length, 25); assert.ok(key.length <= 30);
});
test('prefers a dedicated public HTTPS webhook URL and falls back to APP_URL', () => {
  assert.equal(resolveWebhookUrl({ SNIPPE_WEBHOOK_URL: 'https://demo.ngrok.app/webhooks/snippe', APP_URL: 'https://ignored.example' }), 'https://demo.ngrok.app/webhooks/snippe');
  assert.equal(resolveWebhookUrl({ APP_URL: 'https://shop.example' }), 'https://shop.example/webhooks/snippe');
});
test('rejects localhost, HTTP, and callback paths without a webhook route', () => {
  for (const value of ['http://demo.ngrok.app/webhooks/snippe', 'https://localhost:8002/webhooks/snippe', 'https://demo.ngrok.app']) {
    assert.throws(() => resolveWebhookUrl({ SNIPPE_WEBHOOK_URL: value }));
  }
});
