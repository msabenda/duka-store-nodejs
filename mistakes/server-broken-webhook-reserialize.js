// 🚨 MISTAKE 3A: Webhook signature verified against re-serialized JSON
//
// What's wrong?  Express parses req.body into a JS object (express.json() middleware),
// then JSON.stringify(payload) re-serializes it.  The re-serialized string may differ
// from the original request body (whitespace, key ordering) — causing HMAC to fail.
//
// The error:  401 → { "status": "forged" }
//
// Fix: Use express.raw({ type: 'application/json' }) and hash req.body as a Buffer.
// ----------------------------------------------------------------------------------

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
app.use(express.json());       // ← parses ALL JSON bodies, including webhook
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
  req.session.user = { id: user.id, firstname: user.firstname, lastname: user.lastname, email: user.email };
  res.redirect('/');
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null, cart_count: 0, user: null });
});

app.post('/register', (req, res) => {
  const { firstname, lastname, email, password, password2 } = req.body;
  if (password !== password2) return res.render('register', { error: 'Passwords do not match.', cart_count: 0, user: null });
  if (password.length < 8) return res.render('register', { error: 'Password must be at least 8 characters.', cart_count: 0, user: null });
  const users = readJSON('users.json');
  if (users.find(u => u.email === email)) return res.render('register', { error: 'An account with this email already exists.', cart_count: 0, user: null });
  const id = users.length ? Math.max(...users.map(u => u.id)) + 1 : 1;
  users.push({ id, firstname, lastname, email, password: bcrypt.hashSync(password, 10), created_at: new Date().toISOString() });
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
app.get('/checkout', auth, (req, res) => {
  const { items, count } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');
  res.render('checkout', { items, total: cartData(req.session.cart).total, cart_count: count, user: req.session.user });
});

async function processPayment(req, res, paymentMethod) {
  const { items, total: totalAmount, count } = cartData(req.session.cart);
  if (!items.length) return res.redirect('/cart');

  const { customer_name, customer_email, customer_phone } = req.body;
  if (!customer_name || !customer_email || !customer_phone) return res.redirect('/checkout');

  const user = req.session.user;
  const reference = 'DUKA-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const nameParts = customer_name.split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ');

  const customer = { firstname: firstName, lastname: lastName, email: customer_email };
  const phone = formatPhone(customer_phone);
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

  req.session.cart = [];

  if (response.success) {
    const data = response.data?.data || {};
    if (paymentMethod === 'mobile') return res.redirect(`/order/${reference}`);
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

// ── Webhook ──
app.post('/webhook', (req, res) => {
  // 🚨 BUG: req.body is already parsed by express.json() middleware.
  // JSON.stringify(JSON.parse(body)) may produce different byte sequence
  // than the original request body → HMAC mismatch → "forged"
  const payload = req.body;
  const raw = JSON.stringify(payload);   // 🚨 re-serialized!

  // Verify signature
  const secret = process.env.SNIPPE_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers['snippe-signature'];
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(401).json({ status: 'forged' });
    }
  }

  const event = payload.event || payload.type || 'unknown';
  let reference = payload.reference || payload.order_reference;

  if (!reference && payload.data?.metadata?.reference) reference = payload.data.metadata.reference;
  if (!reference && payload.data?.description) {
    const match = payload.data.description.match(/DUKA-[A-Z0-9]+/);
    if (match) reference = match[0];
  }

  if (!reference) return res.json({ status: 'ignored' });

  const statusMap = {
    'payment.completed': 'completed', 'payment.successful': 'completed', 'payment.confirmed': 'completed',
    'payment.failed': 'failed', 'payment.cancelled': 'cancelled', 'payment.expired': 'expired', 'checkout.expired': 'expired',
  };

  const newStatus = statusMap[event];
  if (newStatus) {
    const orders = readJSON('orders.json');
    const idx = orders.findIndex(o => o.reference === reference);
    if (idx !== -1) {
      orders[idx].status = newStatus;
      writeJSON('orders.json', orders);
      console.log(`Order ${reference} updated to ${newStatus}`);
    }
  }

  res.json({ status: 'ok' });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`🛍️  Duka Store (Node.js) running at http://localhost:${PORT}`);
});
