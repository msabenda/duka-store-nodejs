import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const STATUS = new Map([
  ['payment.completed', 'completed'], ['payment.successful', 'completed'], ['payment.confirmed', 'completed'], ['payment.succeeded', 'completed'],
  ['session.completed', 'completed'], ['checkout.completed', 'completed'], ['session.payment.completed', 'completed'],
  ['payment.failed', 'failed'], ['session.failed', 'failed'], ['checkout.failed', 'failed'],
  ['payment.cancelled', 'voided'], ['payment.voided', 'voided'], ['session.cancelled', 'voided'], ['checkout.cancelled', 'voided'],
  ['payment.expired', 'expired'], ['session.expired', 'expired'], ['checkout.expired', 'expired'],
]);

function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createFileWebhookStore(dataDir) {
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    isProcessed: id => read('webhook-events.json').some(event => event.event_id === id),
    process(id, payload, update) {
      const events = read('webhook-events.json');
      if (events.some(event => event.event_id === id)) return false;
      if (update) {
        const orders = read('orders.json');
        update(orders);
        atomicWrite(path.join(dataDir, 'orders.json'), orders);
      }
      events.push({ event_id: id, processed_at: new Date().toISOString(), payload });
      atomicWrite(path.join(dataDir, 'webhook-events.json'), events);
      return true;
    },
    orders: () => read('orders.json'),
  };
}

export function verifyWebhook({ rawBody, timestamp, signature, secret, now = Date.now() }) {
  if (!secret) return { ok: false, code: 503, status: 'webhook_not_configured' };
  if (!Buffer.isBuffer(rawBody) || !timestamp || !signature) return { ok: false, code: 401, status: 'forged' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 300) return { ok: false, code: 401, status: 'stale' };
  const suppliedHex = String(signature).trim().replace(/^sha256\s*=\s*/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(suppliedHex)) return { ok: false, code: 401, status: 'forged' };
  const expected = crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody])).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return { ok: false, code: 401, status: 'forged' };
  return { ok: true };
}

function canonicalStatus(type, data) {
  const direct = STATUS.get(String(type).toLowerCase());
  if (direct) return direct;
  const value = String(data?.status || '').toLowerCase();
  return ({ completed: 'completed', successful: 'completed', confirmed: 'completed', succeeded: 'completed', failed: 'failed', cancelled: 'voided', voided: 'voided', expired: 'expired' })[value];
}

function candidates(data) {
  const metadata = data.metadata || {};
  return {
    orderReference: metadata.order_reference || data.order_reference,
    orderId: metadata.order_id || data.order_id,
    providerReference: data.reference || data.payment_reference || data.provider_reference,
  };
}

function amountValue(data) {
  const raw = data.amount?.value ?? data.amount;
  return raw === undefined || raw === null || raw === '' ? null : Number(raw);
}

export function handleVerifiedEvent(payload, store) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id || typeof payload.type !== 'string' || !payload.type || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return { code: 400, body: { status: 'invalid_envelope' } };
  }
  if (store.isProcessed(payload.id)) return { code: 200, body: { status: 'duplicate' } };

  const status = canonicalStatus(payload.type, payload.data);
  const refs = candidates(payload.data);
  const orders = store.orders();
  const index = orders.findIndex(order =>
    (refs.orderReference && order.reference === refs.orderReference) ||
    (refs.orderId && (order.attempt_id === refs.orderId || String(order.id || '') === String(refs.orderId))) ||
    (refs.providerReference && order.snippe_reference === refs.providerReference));

  if (index < 0) {
    store.process(payload.id, payload);
    return { code: 200, body: { status: 'ignored', reason: 'unknown_order' } };
  }
  if (!status) {
    store.process(payload.id, payload);
    return { code: 200, body: { status: 'ignored', reason: 'unknown_event' } };
  }

  const order = orders[index];
  if (order.status === 'completed' && status !== 'completed') {
    store.process(payload.id, payload);
    return { code: 200, body: { status: 'ignored', reason: 'monotonic' } };
  }
  if (status === 'completed') {
    const amount = amountValue(payload.data);
    const currency = String(payload.data.currency || payload.data.amount?.currency || '').toUpperCase();
    const hasOrderIdentity = Boolean(refs.orderReference || refs.orderId || refs.providerReference);
    if (!hasOrderIdentity || !Number.isFinite(amount) || amount !== Number(order.amount) || !currency || currency !== String(order.currency).toUpperCase()) {
      store.process(payload.id, payload);
      return { code: 200, body: { status: 'ignored', reason: 'payment_mismatch' } };
    }
  }

  store.process(payload.id, payload, persisted => {
    const target = persisted.find(item => item.reference === order.reference);
    target.status = status;
    target.updated_at = new Date().toISOString();
  });
  return { code: 200, body: { status: 'ok' } };
}

export function createWebhookHandler({ store, secret = () => process.env.SNIPPE_WEBHOOK_SECRET, now = () => Date.now() }) {
  return (req, res) => {
    const rawBody = req.body;
    const timestamp = String(req.get('x-webhook-timestamp') || req.get('snippe-timestamp') || '');
    const signature = String(req.get('x-webhook-signature') || req.get('snippe-signature') || '');
    const auth = verifyWebhook({ rawBody, timestamp, signature, secret: secret(), now: now() });
    if (!auth.ok) return res.status(auth.code).json({ status: auth.status });
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ status: 'invalid_json' }); }
    const result = handleVerifiedEvent(payload, store);
    return res.status(result.code).json(result.body);
  };
}
