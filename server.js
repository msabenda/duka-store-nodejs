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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8002;
const APP_URL = (process.env.APP_URL || 'http://localhost:' + PORT).replace('http://', 'https://');

const app = express();

// ── Middleware ──
// Capture the raw request body so webhook signatures can be verified against
// the exact bytes Snippe sent. Re-serializing parsed JSON (JSON.stringify)
// can change whitespace/key order and break the HMAC → 401 forged.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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

function formatPhone(phone) {
  let p = phone.replace(/^\+/, '');
  if (p.length === 9) p = '255' + p;
  else if (p.length === 10 && p.startsWith('0')) p = '255' + p.slice(1);
  return p;
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

// ── Checkout ──
// 🎙️ DA NOTE — YOUR CUSTOM CHECKOUT (you built this page — reused in later sessions)
// This is YOUR checkout page: customer details form + payment method buttons
// (Mobile Money / Card / QR), rendered by views/checkout.ejs. Snippe's hosted
// checkout (the payment_url redirect) is the alternative — this page is the
// part you own: what you collect, what you validate, what you send to Snippe.
//
// ⚠️ DISABLED FOR NOW — hosted Snippe checkout only (see POST /checkout/hosted).
// The custom checkout page is commented out; uncomment to restore it.
//
// app.get('/checkout', auth, (req, res) => {
//   const { items, count } = cartData(req.session.cart);
//   if (!items.length) return res.redirect('/cart');
//   res.render('checkout', { items, total: cartData(req.session.cart).total, cart_count: count, user: req.session.user });
// });

async function processPayment(req, res, paymentMethod) {
  const { items, total: totalAmount, count } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');

  const { customer_name, customer_email, customer_phone } = req.body;
  // Phone is only required for mobile money. The hosted checkout flow (POST
  // /checkout/hosted) uses the logged-in user's details and sends '' for phone.
  if (!customer_name || !customer_email) return res.redirect('/cart');

  const user = req.session.user;
  const reference = 'DUKA-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const nameParts = customer_name.split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ');

  // Billing details are required by the card API. The hosted checkout flow uses
  // defaults (demo store in Tanzania); the custom form can collect them later.
  const customer = {
    firstname: firstName, lastname: lastName, email: customer_email,
    address: req.body.customer_address || 'Dar es Salaam',
    city: req.body.customer_city || 'Dar es Salaam',
    state: req.body.customer_state || 'DSM',
    postcode: req.body.customer_postcode || '14101',
    country: req.body.customer_country || 'TZ',
  };
  const phone = formatPhone(customer_phone);
  // 🎙️ DA NOTE — SESSION → REDIRECT → RETURN URL FLOW (Session 3)
  // One payment session per checkout intent. The DUKA- reference is baked into
  // the return URLs AND metadata, so the webhook (next session!) can reconcile
  // the payment back to this exact order. Reference + metadata = your audit
  // trail — Snippe echoes both back in every webhook payload.
  const successUrl = `${APP_URL}/order/${reference}`;
  const cancelUrl = `${APP_URL}/order/${reference}`;
  const webhookUrl = `${APP_URL}/webhook`;
  const metadata = { order_reference: reference, source: 'duka-store-nodejs' };

  let response;
  if (paymentMethod === 'mobile') {
    response = await snippe.createMobilePayment(totalAmount, 'TZS', phone, customer, webhookUrl, metadata);
  } else if (paymentMethod === 'card') {
    response = await snippe.createCardPayment(totalAmount, 'TZS', successUrl, cancelUrl, customer, phone, webhookUrl, metadata);
  } else {
    response = await snippe.createQrPayment(totalAmount, 'TZS', customer, successUrl, cancelUrl, phone, webhookUrl, metadata);
  }

  const snippeRef = response.success ? (response.data?.data?.reference || null) : null;

  // Save order
  const orders = readJSON('orders.json');
  const orderItems = items.map(i => ({
    product_id: i.product.id, product_name: i.product.name, price: i.product.price,
    quantity: i.quantity, subtotal: i.subtotal, image: i.product.image,
  }));
  const order = {
    reference, snippe_reference: snippeRef, user_id: user.id, amount: totalAmount,
    currency: 'TZS', status: 'pending', payment_method: paymentMethod, items: orderItems,
    customer_name, customer_email, customer_phone,
    created_at: new Date().toISOString(),
  };
  orders.push(order);
  writeJSON('orders.json', orders);

  // 🎙️ DA NOTE — ONE SESSION PER CHECKOUT INTENT
  // Cart cleared immediately after session creation: one intent → one session.
  // Never loop/re-create sessions on retries (foreshadows the abuse-signals
  // session — repeated session creation is a classic abuse signal).
  req.session.cart = [];

  if (response.success) {
    const data = response.data?.data || {};
    if (paymentMethod === 'mobile') return res.redirect(`/order/${reference}`);
    // 🎙️ DA NOTE — REDIRECT ≠ PROOF OF PAYMENT
    // Landing back here only means the customer visited the hosted checkout.
    // The order is still 'pending' until the webhook flips it. Tell the
    // community: never ship redirect-only confirmation — webhook is the truth.
    const checkoutUrl = data.payment_url;
    if (checkoutUrl) return res.redirect(checkoutUrl);
    return res.redirect(`/order/${reference}`);
  }

  const err = response.error || 'Could not create payment.';
  res.redirect(`/order/${reference}?error=${encodeURIComponent(err)}`);
}

app.post('/checkout/mobile', auth, (req, res) => processPayment(req, res, 'mobile'));
app.post('/checkout/card', auth, (req, res) => processPayment(req, res, 'card'));
app.post('/checkout/qr', auth, (req, res) => processPayment(req, res, 'dynamic-qr'));

// ── Hosted Checkout via Payment Sessions (Snippe) ──
// 🎙️ DA NOTE — the cart's "Checkout" button posts here. It creates a PAYMENT
// SESSION (POST /sessions) with the cart total + the logged-in user's details,
// then redirects the customer to Snippe's HOSTED CHECKOUT page (checkout_url)
// where they fill/confirm their details and pay (mobile money). The order
// stays 'pending' until the webhook confirms it.
// Docs: https://docs.snippe.sh/docs/2026-01-25/sessions
app.post('/checkout/pay', auth, async (req, res) => {
  const { items, total: totalAmount } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');

  const user = req.session.user;
  // Pre-fill the hosted checkout with the account details (editable on Snippe's page).
  const customer = {
    name: `${user.firstname} ${user.lastname}`.trim(),
    email: user.email,
    phone: formatPhone(user.phone || ''),
  };
  if (!customer.name || !customer.email || !customer.phone) {
    return res.render('register', { error: 'Your account needs a name, email and phone for checkout - please register again.', cart_count: 0, user: null });
  }

  const reference = 'DUKA-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const redirectUrl = `${APP_URL}/success?ref=${reference}`;
  const webhookUrl = `${APP_URL}/webhook`;
  const metadata = { order_reference: reference, source: 'duka-store-nodejs' };

  const response = await snippe.createSession({
    amount: totalAmount,
    currency: 'TZS',
    customer,
    redirect_url: redirectUrl,
    webhook_url: webhookUrl,
    metadata,
    description: `Duka Store order ${reference}`,
  });

  const snippeRef = response.success ? (response.data?.data?.reference || null) : null;

  // Save the order locally (pending until the webhook confirms it).
  const orders = readJSON('orders.json');
  const orderItems = items.map(i => ({
    product_id: i.product.id, product_name: i.product.name, price: i.product.price,
    quantity: i.quantity, subtotal: i.subtotal, image: i.product.image,
  }));
  orders.push({
    reference, snippe_reference: snippeRef, user_id: user.id, amount: totalAmount,
    currency: 'TZS', status: 'pending', payment_method: 'session', items: orderItems,
    customer_name: customer.name, customer_email: customer.email, customer_phone: customer.phone,
    created_at: new Date().toISOString(),
  });
  writeJSON('orders.json', orders);
  req.session.cart = [];

  if (response.success) {
    const checkoutUrl = response.data?.data?.checkout_url;
    if (checkoutUrl) return res.redirect(checkoutUrl);
    return res.redirect(`/order/${reference}`);
  }

  const err = response.error || 'Could not create payment.';
  res.redirect(`/order/${reference}?error=${encodeURIComponent(err)}`);
});

// ── Orders ──
app.get('/order/:ref', (req, res) => {
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.reference === req.params.ref);
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

// ── Success page (customer lands here after paying on Snippe's hosted checkout) ──
// 🎙️ DA NOTE — this page RECEIVES the customer after the hosted checkout. It
// reads the order reference from ?ref= and shows the order's REAL status.
// The redirect is NOT proof of payment: the page shows 'pending' until the
// webhook flips the order. A small poll re-checks the status so the page
// updates (green tick) the moment the webhook lands.
app.get('/success', (req, res) => {
  const ref = req.query.ref;
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.reference === ref);
  const { count } = cartData(req.session.cart);
  res.render('success', { order: order || null, cart_count: count, user: req.session.user });
});

// JSON status endpoint used by the success page poll.
app.get('/success/status', (req, res) => {
  const ref = req.query.ref;
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.reference === ref);
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status });
});

// ── Webhook ──
// 🎙️ DA NOTE — the webhook is the SOURCE OF TRUTH (teased in Session 3,
// deep-dive next session). It resolves the order by `reference` and only
// updates status after the HMAC signature verifies.
app.post('/webhook', (req, res) => {
  const payload = req.body;

  // Always log the raw event so webhook delivery can be debugged live.
  console.log('WEBHOOK received:', JSON.stringify(payload));

  // Verify against the RAW body buffer (captured by the verify hook above).
  const raw = req.rawBody || Buffer.from(JSON.stringify(payload));

  const secret = process.env.SNIPPE_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers['snippe-signature'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(signature);
    // timingSafeEqual throws on length mismatch — compare lengths first.
    const valid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
    if (!valid) {
      console.log('WEBHOOK forged/signature mismatch (check SNIPPE_WEBHOOK_SECRET matches the dashboard)');
      return res.status(401).json({ status: 'forged' });
    }
  }

  const event = payload.event || payload.type || 'unknown';
  let reference = payload.reference || payload.order_reference || payload.metadata?.order_reference;

  if (!reference && payload.data?.metadata?.reference) reference = payload.data.metadata.reference;
  if (!reference && payload.data?.metadata?.order_reference) reference = payload.data.metadata.order_reference;
  if (!reference && payload.data?.description) {
    const match = payload.data.description.match(/DUKA-[A-Z0-9]+/);
    if (match) reference = match[0];
  }

  if (!reference) return res.json({ status: 'ignored' });

  const statusMap = {
    'payment.completed': 'completed', 'payment.successful': 'completed', 'payment.confirmed': 'completed',
    'payment.succeeded': 'completed', 'session.completed': 'completed', 'checkout.completed': 'completed',
    'session.payment.completed': 'completed',
    'payment.failed': 'failed', 'session.failed': 'failed', 'checkout.failed': 'failed',
    'payment.cancelled': 'cancelled', 'session.cancelled': 'cancelled', 'checkout.cancelled': 'cancelled',
    'payment.expired': 'expired', 'session.expired': 'expired', 'checkout.expired': 'expired',
    'payment.pending': 'pending', 'session.pending': 'pending', 'checkout.pending': 'pending',
  };

  const newStatus = statusMap[event];
  if (newStatus) {
    const orders = readJSON('orders.json');
    // Resolve by our order reference OR by the stored Snippe session reference.
    let idx = orders.findIndex(o => o.reference === reference);
    if (idx === -1) idx = orders.findIndex(o => o.snippe_reference === reference);
    if (idx !== -1) {
      orders[idx].status = newStatus;
      writeJSON('orders.json', orders);
      console.log(`Order ${reference} updated to ${newStatus}`);
    } else {
      console.log(`WEBHOOK: no order found for reference ${reference}`);
    }
  }

  res.json({ status: 'ok' });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`🛍️  Duka Store (Node.js) running at http://localhost:${PORT}`);
});
