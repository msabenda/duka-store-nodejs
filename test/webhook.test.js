import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyWebhook, handleVerifiedEvent } from '../webhook.js';

const secret = 'test-secret';
const now = 2_000_000_000_000;
const timestamp = String(now / 1000);
const sign = (raw, ts = timestamp, key = secret) => crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex');

function memoryStore(seed) {
  let orders = structuredClone(seed);
  const events = [];
  return {
    orders: () => structuredClone(orders),
    isProcessed: id => events.some(e => e.event_id === id),
    process(id, payload, update) {
      if (this.isProcessed(id)) return false;
      if (update) update(orders);
      events.push({ event_id: id, payload });
      return true;
    },
    state: () => ({ orders, events }),
  };
}
const base = { reference: 'DUKA-ABC', attempt_id: 'attempt-1', snippe_reference: 'pay-1', amount: 2500, currency: 'TZS', status: 'pending' };
const event = (id, type, data = {}) => ({ id, type, data });

test('HMAC covers timestamp dot and exact raw bytes', () => {
  const raw = Buffer.from('{ "id":"evt-1", "type":"payment.completed", "data":{} }');
  assert.deepEqual(verifyWebhook({ rawBody: raw, timestamp, signature: sign(raw), secret, now }), { ok: true });
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw)));
  assert.equal(verifyWebhook({ rawBody: reserialized, timestamp, signature: sign(raw), secret, now }).status, 'forged');
});

test('fails closed for missing secret, malformed/missing signature, and stale timestamps', () => {
  const raw = Buffer.from('{}');
  assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature: sign(raw), secret: '', now }).code, 503);
  for (const signature of ['', 'ab', 'z'.repeat(64), 'a'.repeat(62)]) assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature, secret, now }).code, 401);
  assert.equal(verifyWebhook({ rawBody: raw, timestamp: String(now / 1000 - 301), signature: sign(raw, String(now / 1000 - 301)), secret, now }).status, 'stale');
  assert.equal(verifyWebhook({ rawBody: raw, timestamp: String(now / 1000 + 301), signature: sign(raw, String(now / 1000 + 301)), secret, now }).status, 'stale');
});

test('requires the 2026 envelope id/type/data', () => {
  for (const payload of [{}, { id: 'x', type: 'payment.completed' }, { id: '', type: 'x', data: {} }, { id: 'x', type: '', data: {} }, { id: 'x', type: 'x', data: [] }]) {
    assert.equal(handleVerifiedEvent(payload, memoryStore([base])).code, 400);
  }
});

test('matches order_reference, order_id, and provider reference', () => {
  const variants = [
    { metadata: { order_reference: base.reference } },
    { metadata: { order_id: base.attempt_id } },
    { reference: base.snippe_reference },
  ];
  variants.forEach((identity, i) => {
    const store = memoryStore([base]);
    const result = handleVerifiedEvent(event(`evt-${i}`, 'payment.completed', { ...identity, amount: 2500, currency: 'tzs' }), store);
    assert.equal(result.body.status, 'ok');
    assert.equal(store.state().orders[0].status, 'completed');
  });
});

test('canonicalizes failed, voided, expired and completed statuses', () => {
  for (const [type, expected] of [['payment.failed', 'failed'], ['payment.cancelled', 'voided'], ['payment.expired', 'expired'], ['payment.succeeded', 'completed']]) {
    const store = memoryStore([base]);
    const data = { metadata: { order_reference: base.reference }, ...(expected === 'completed' ? { amount: 2500, currency: 'TZS' } : {}) };
    handleVerifiedEvent(event(type, type, data), store);
    assert.equal(store.state().orders[0].status, expected);
  }
});

test('never downgrades completed orders', () => {
  const store = memoryStore([{ ...base, status: 'completed' }]);
  const result = handleVerifiedEvent(event('evt-down', 'payment.failed', { reference: 'pay-1' }), store);
  assert.equal(result.body.reason, 'monotonic');
  assert.equal(store.state().orders[0].status, 'completed');
});

test('completion requires matching amount, currency, and order identity', () => {
  for (const data of [
    { metadata: { order_reference: base.reference }, amount: 2499, currency: 'TZS' },
    { metadata: { order_reference: base.reference }, amount: 2500, currency: 'USD' },
    { metadata: { order_reference: base.reference }, currency: 'TZS' },
  ]) {
    const store = memoryStore([base]);
    const result = handleVerifiedEvent(event(crypto.randomUUID(), 'payment.completed', data), store);
    assert.equal(result.body.reason, 'payment_mismatch');
    assert.equal(store.state().orders[0].status, 'pending');
  }
});

test('valid duplicate, unknown order, and unknown event return 2xx and dedupe durably', () => {
  const store = memoryStore([base]);
  const unknown = event('evt-unknown-order', 'payment.failed', { metadata: { order_reference: 'NOPE' } });
  assert.equal(handleVerifiedEvent(unknown, store).code, 200);
  assert.equal(handleVerifiedEvent(unknown, store).body.status, 'duplicate');
  const unknownType = event('evt-unknown-type', 'payment.refunded', { reference: 'pay-1' });
  assert.equal(handleVerifiedEvent(unknownType, store).code, 200);
  assert.equal(store.state().events.length, 2);
});
