# ACME Retail

Simulated storefront and back office. Customers browse a catalog, save a wishlist, check out with coupons and illustrative shipping and tax, and track orders. Staff manage products, inventory, fulfillment, and refunds. Payments are simulated. No real money moves, and card numbers are never collected.

## Stack

- Next.js 16, React 19, TypeScript, Tailwind CSS 4
- pnpm
- Supabase PostgreSQL, Auth, Storage, and Realtime when configured
- Optional Stripe Checkout in test mode
- One Next.js app serves the screens and the API, deployed together on Vercel

## Roles

| Email | Role | Can open |
| --- | --- | --- |
| customer@acme-retail.test | Customer | Shop, cart, checkout, orders, tracking, returns |
| catalog@acme-retail.test | Catalog | Products |
| warehouse@acme-retail.test | Warehouse | Inventory and fulfillment |
| finance@acme-retail.test | Finance | Orders and refunds |
| admin@acme-retail.test | Administrator | All back office, including scenarios |

Demo password for every sample account: `Retail123!`

There are also customer accounts `jordan.lee@acme-retail.test` and `sam.patel@acme-retail.test`.

## Run locally

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. The first request creates `.data/acme-retail.json` with 40 products and 60 orders. Reloading the page keeps that data.

Useful paths:

- `/` home, `/catalog`, `/product/[slug]`, `/cart`, `/checkout`
- `/payment/result`, `/account`, `/account/orders`, `/account/orders/[id]`, `/account/returns`
- `/login`, `/recover`, `/reset`, `/account/profile`, `/account/settings`
- `/office/products`, `/office/inventory`, `/office/orders`, `/office/refunds`, `/office/scenarios`

Coupons: `WELCOME10`, `SAVE5`, `FREESHIP`. Standard shipping is free over $75. Tax is an illustrative 8.25% and is not charged on shipping.

Checkout reserves stock for 15 minutes and stores the variant price on the order. Simulated outcomes are approved, declined, authentication required, and timeout. Payment status and delivery status are updated separately. Refunds can be full or partial.

Administrators can change the default scenario, advance shipments, inspect events, and reset the seed from `/office/scenarios`.

## Checks

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

## Supabase

1. Create a Supabase project.
2. Run [supabase/migrations/001_retail.sql](supabase/migrations/001_retail.sql) in the SQL editor.
3. Copy `.env.example` to `.env.local` and fill in the project URL, anon key, and service role key.
4. In Authentication, enable email and password. Add the staff and customer users, or keep using the local session store until those users exist.
5. Restart `pnpm dev`.

When both `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, the API loads and saves the store snapshot in `retail_state` and mirrors order status into `order_feed` for Realtime. Row level security is enabled. There is no client write policy: the Next.js API authorizes the actor, then uses the service role. Return photos go to the private `return-photos` bucket. Without Supabase, photos are stored under `.data/uploads`.

The service role key must stay on the server. Do not prefix it with `NEXT_PUBLIC_`.

Password recovery uses a one-time hashed token that expires in 30 minutes. Without Supabase email, the demo mailbox on `/recover` shows the link only for the browser session that requested it. The response does not reveal whether the email exists.

## Stripe test mode

Set `STRIPE_SECRET_KEY` to a key that starts with `sk_test_`. Checkout then offers Stripe test checkout. The webhook route is `/api/webhooks/stripe` and rejects requests whose `Stripe-Signature` does not match `STRIPE_WEBHOOK_SECRET`. A verified `checkout.session.completed` event captures the reserved stock. Live secret keys are not accepted.

## Deploy on Vercel

The web screens and API are the same Next.js project. There is no separate API service to deploy.

1. Push the repository to GitHub.
2. Import it in Vercel. The install command is `pnpm install` and the build command is `pnpm build`.
3. Add the environment variables from `.env.example` in the Vercel project settings. Use the Supabase service role only as a server variable.
4. Deploy. Vercel serves both the pages and `/api/*`.
5. Point the Stripe webhook, if used, at `https://YOUR_DOMAIN/api/webhooks/stripe`.

The local JSON file is not durable on Vercel. Production persistence requires the Supabase variables.

## Security notes

Implemented in this repository: security headers, same-origin checks on mutations, rate limits, generic login errors, account lockout, scrypt password hashes, httpOnly session cookies, server-side price and coupon calculation, stock reservation checks, role checks, upload type and size checks, Stripe signature verification, and audit events. Hosted Supabase, Vercel, dependency scanning, penetration testing, and operational monitoring were not verified in this workspace.

The SD Elements project ACME Retail has 409 countermeasures. After local review they are 78 Complete, 292 Incomplete, and 39 Not Applicable. Each one has a Brazilian Portuguese and English note signed RafahMarinho with Agentic AI. Complete means the control is in this code and was exercised by the local tests or production build. Incomplete means it applies but was not implemented or not verified here, including hosted database, TLS, backups, scanning, and privacy operations. Not Applicable means the control targets a platform or technology this application does not run.


