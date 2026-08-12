# Duka Store - Snippe Payments Demo (Node.js / Express)

> Duka Store is a small demo storefront that shows developers how to accept
> payments with the Snippe Payments API. It collects payments via Mobile Money,
> Cards, and QR Codes using raw HTTP - no SDK. This is the Node.js / Express edition.

## What Is Duka Store?

A tiny clothes shop (8 products, 500 TZS each) wired to Snippe end to end:
customers register, add items to a cart, check out, and pay through Snippe's
hosted flows, while the store tracks orders and reconciles them with webhooks.
Use it as a reference when integrating Snippe into any Node.js or JavaScript
project.

## What It Demonstrates

- Mobile Money - USSD push sent to the customer's phone
- Card payments - hosted checkout redirect (Snippe handles card entry and 3D Secure)
- Dynamic QR - QR code the customer scans with a mobile money app
- Webhooks - async payment status updates (the source of truth)
- Order reconciliation - matching payments to orders via reference and metadata

## Editions

The same store is available in three frameworks. Pick your stack:

| Stack | Location |
|---|---|
| Node.js / Express | this repository |
| Django | ../duka_store_django |
| Laravel 13 | ../duka-store-laravel |

## Quick Start

```bash
npm install
# edit .env: set SNIPPE_API_KEY, APP_URL (https), SESSION_SECRET
npm start
# -> http://localhost:8002
```

Snippe requires a reachable HTTPS URL for webhooks and redirects. For local
testing, run `ngrok http 8002` and set `APP_URL` to the https URL it gives you.

## Project Structure

```
duka-store-nodejs/
|-- server.js      # routes, checkout flow, webhook handler
|-- snippe.js      # raw HTTP calls to the Snippe API
|-- catalog.js     # product catalog
|-- views/         # EJS templates (store UI)
|-- data/          # JSON storage (users, orders)
`-- .env           # SNIPPE_API_KEY, APP_URL, SESSION_SECRET
```

## Series Guides

Deep dives live in per-series guides:

- [Series 3 - Hosted Checkout with Payment Sessions](SERIES-3-README.md) -
  create session -> redirect -> return URL, what belongs in a session, and why
  the redirect is not proof of payment

More series guides will be added here as the series grows.

## Documentation

- [Snippe API documentation](https://docs.snippe.sh)
- [Payment Sessions](https://docs.snippe.sh/docs/2026-01-25/sessions)
- [Payment Profiles](https://docs.snippe.sh/docs/2026-01-25/sessions/profiles)
- [Payment Links](https://docs.snippe.sh/docs/2026-01-25/sessions/payment-links)
- [Webhooks](https://docs.snippe.sh/docs/2026-01-25/webhooks)
