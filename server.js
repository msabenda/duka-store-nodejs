import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRODUCTS, productById } from './catalog.js';
import * as snippe from './snippe.js';
import { createFileWebhookStore, createWebhookHandler } from './webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8002;
const APP_URL = (process.env.APP_URL || 'http://localhost:' + PORT).replace(/\/$/, '');

export function resolveWebhookUrl(env = process.env) {
  const configured = String(env.SNIPPE_WEBHOOK_URL || '').trim();
  const candidate = configured || `${String(env.APP_URL || APP_URL).replace(/\/$/, '')}/webhooks/snippe`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('SNIPPE_WEBHOOK_URL must be a valid public HTTPS callback URL.'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' || local || !['/webhook', '/webhooks/snippe'].includes(url.pathname.replace(/\/$/, ''))) {
    throw new Error('Set SNIPPE_WEBHOOK_URL to a public HTTPS URL ending in /webhooks/snippe (or /webhook).');
  }
  return url.toString().replace(/\/$/, '');
}

const app = express();

// ── Middleware ──
// The webhook must receive the exact bytes before any JSON parser runs.
const webhookStore = createFileWebhookStore(path.join(__dirname, 'data'));
app.post(['/webhooks/snippe', '/webhook'], express.raw({ type: 'application/json', limit: '1mb' }), createWebhookHandler({ store: webhookStore }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'duka-store-dev-secret', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Helpers ──
function cartData(sessionCart) {
  const cart = sessionCart || [];
  const items = [];
  let total = 0;
  for (const item of cart) {
    const product = productById(item.product_id);
    if (product) {
      const subtotal = product.price * item.quantity;
      total += subtotal;
      items.push({ product, quantity: item.quantity, subtotal });
    }
  }
  return { items, total, count: items.length };
}

function readJSON(file) {
  const p = path.join(__dirname, 'data', file);
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(__dirname, 'data', file), JSON.stringify(data, null, 2));
}

export function formatPhone(phone = '') {
  const digits = String(phone).replace(/[\s().-]/g, '').replace(/^\+/, '');
  let normalized = digits;
  if (/^[67]\d{8}$/.test(digits)) normalized = '255' + digits;
  else if (/^0[67]\d{8}$/.test(digits)) normalized = '255' + digits.slice(1);
  if (!/^255[67]\d{8}$/.test(normalized)) throw new Error('Enter a valid Tanzania mobile number.');
  return normalized;
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function csrf(req, res, next) {
  const supplied = String(req.body?._csrf || '');
  const expected = String(req.session.csrf || '');
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(403).send('Invalid CSRF token');
  next();
}

function auth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// ── Auth ──
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, cart_count: 0, user: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const users = readJSON('users.json');
  const user = users.find(u => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    const { items, count } = cartData(req.session.cart);
    return res.render('login', { error: 'Invalid email or password.', cart_count: count, user: null });
  }
  req.session.user = { id: user.id, firstname: user.firstname, lastname: user.lastname, email: user.email, phone: user.phone || '' };
  res.redirect('/');
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null, cart_count: 0, user: null });
});

app.post('/register', (req, res) => {
  const { firstname, lastname, email, phone, password, password2 } = req.body;
  if (password !== password2) return res.render('register', { error: 'Passwords do not match.', cart_count: 0, user: null });
  if (password.length < 8) return res.render('register', { error: 'Password must be at least 8 characters.', cart_count: 0, user: null });
  if (!phone) return res.render('register', { error: 'Phone number is required (Snippe needs it for payments).', cart_count: 0, user: null });
  const users = readJSON('users.json');
  if (users.find(u => u.email === email)) return res.render('register', { error: 'An account with this email already exists.', cart_count: 0, user: null });
  const id = users.length ? Math.max(...users.map(u => u.id)) + 1 : 1;
  users.push({ id, firstname, lastname, email, phone, password: bcrypt.hashSync(password, 10), created_at: new Date().toISOString() });
  writeJSON('users.json', users);
  res.redirect('/login?registered=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ── Home ──
app.get('/', (req, res) => {
  const { count } = cartData(req.session.cart);
  res.render('index', { products: PRODUCTS, cart_count: count, user: req.session.user });
});

// ── Cart ──
app.get('/cart', (req, res) => {
  const { items, total, count } = cartData(req.session.cart);
  res.render('cart', { items, total, cart_count: count, user: req.session.user });
});

app.get('/cart/add/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const product = productById(id);
  if (!product) return res.redirect('/');
  const cart = req.session.cart || [];
  const existing = cart.find(i => i.product_id === id);
  if (existing) existing.quantity++;
  else cart.push({ product_id: id, quantity: 1 });
  req.session.cart = cart;
  res.redirect('/');
});

app.get('/cart/remove/:idx', (req, res) => {
  const cart = req.session.cart || [];
  const idx = parseInt(req.params.idx);
  if (idx >= 0 && idx < cart.length) cart.splice(idx, 1);
  req.session.cart = cart;
  res.redirect('/cart');
});

// ── Checkout: Series 7 direct mobile money ──
app.get('/checkout', auth, (req, res) => {
  const { items, total, count } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');
  res.render('checkout', { items, total, cart_count: count, user: req.session.user, csrf: csrfToken(req), error: null });
});

app.post('/checkout/mobile', auth, csrf, async (req, res) => {
  const { items, total, count } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');
  const customer_name = String(req.body.customer_name || '').trim();
  const customer_email = String(req.body.customer_email || '').trim();
  let phone;
  try { phone = formatPhone(req.body.customer_phone); } catch (e) {
    return res.status(400).render('checkout', { items, total, cart_count: count, user: req.session.user, csrf: csrfToken(req), error: e.message });
  }
  if (!customer_name || !customer_email) return res.status(400).render('checkout', { items, total, cart_count: count, user: req.session.user, csrf: csrfToken(req), error: 'Name and email are required.' });

  const reference = 'DUKA-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const attemptId = crypto.randomUUID();
  const idempotencyKey = ('duka-' + crypto.createHash('sha256').update(attemptId).digest('hex').slice(0, 20)); // 25 chars, stable per persisted attempt
  const names = customer_name.split(/\s+/);
  const order = { reference, attempt_id: attemptId, idempotency_key: idempotencyKey, snippe_reference: null,
    snippe_expires_at: null, user_id: req.session.user.id, amount: Math.round(total), currency: 'TZS', status: 'pending',
    payment_method: 'mobile', items: items.map(i => ({ product_id: i.product.id, product_name: i.product.name, price: i.product.price, quantity: i.quantity, subtotal: i.subtotal, image: i.product.image })),
    customer_name, customer_email, customer_phone: phone, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const orders = readJSON('orders.json'); orders.push(order); writeJSON('orders.json', orders); // durable before network call

  let webhookUrl;
  try { webhookUrl = resolveWebhookUrl(); } catch (error) {
    const current = readJSON('orders.json'); const idx = current.findIndex(o => o.attempt_id === attemptId);
    if (idx !== -1) { current[idx].status = 'failed'; current[idx].failure_reason = error.message; writeJSON('orders.json', current); }
    return res.redirect(`/order/${reference}?error=${encodeURIComponent(error.message)}`);
  }
  const response = await snippe.createMobilePayment({ amount: order.amount, phoneNumber: phone,
    customer: { firstname: names.shift(), lastname: names.join(' '), email: customer_email },
    webhookUrl, metadata: { order_id: attemptId, order_reference: reference }, idempotencyKey });
  const current = readJSON('orders.json'); const idx = current.findIndex(o => o.attempt_id === attemptId);
  if (idx !== -1) {
    const data = response.data?.data || response.data || {};
    current[idx].snippe_reference = data.reference || null; current[idx].snippe_expires_at = data.expires_at || null;
    current[idx].last_api_http_code = response.http_code; current[idx].updated_at = new Date().toISOString();
    if (!response.success) { current[idx].status = 'failed'; current[idx].failure_reason = response.error || 'Payment initiation failed'; }
    // A 201 only means accepted/initiated: status deliberately remains pending.
    writeJSON('orders.json', current);
  }
  if (response.success) req.session.cart = [];
  const error = response.success ? '' : `?error=${encodeURIComponent(response.error || 'Could not initiate payment')}`;
  res.redirect(`/order/${reference}${error}`);
});

/* EDUCATIONAL REFERENCE ONLY — INACTIVE HOSTED SESSIONS FLOW
   Previous Series examples used POST /api/v1/sessions then redirected to
   checkout_url. See snippe.js and 2026-01-25 Sessions docs. The active Series 7
   route above is first-party direct mobile money via POST /v1/payments. */

// ── Orders ──
app.get('/order/:ref', auth, (req, res) => {
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.reference === req.params.ref && o.user_id === req.session.user.id);
  if (!order) return res.status(404).send('Order not found');
  const { count } = cartData(req.session.cart);
  const error = req.query.error || null;
  res.render('order', { order, cart_count: count, user: req.session.user, error });
});

app.get('/dashboard', auth, (req, res) => {
  const orders = readJSON('orders.json').filter(o => o.user_id === req.session.user.id);
  const { count } = cartData(req.session.cart);
  res.render('dashboard', { orders, cart_count: count, user: req.session.user });
});

// Browser polling is scoped to the signed-in owner; provider state is never
// queried from the browser or accepted from client input.
app.get('/api/orders/:ref/status', auth, (req, res) => {
  const order = readJSON('orders.json').find(item => item.reference === req.params.ref && item.user_id === req.session.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.json({ reference: order.reference, status: order.status, updated_at: order.updated_at });
});

// ── Start ──
if (process.env.NODE_ENV !== 'test') app.listen(PORT, () => {
  console.log(`🛍️  Duka Store (Node.js) running at http://localhost:${PORT}`);
});
export { app };
