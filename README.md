# ACME Retail

Simulated storefront and back office. Customers browse a catalog, save a wishlist, check out with coupons and illustrative shipping and tax, and track orders. Staff manage products, inventory, fulfillment, and refunds. Payments are simulated. No real money moves, and card numbers are never collected.

## Stack

- Next.js 16, React 19, TypeScript, Tailwind CSS 4
- pnpm, Node.js 22 (`.nvmrc`)
- Supabase PostgreSQL (state snapshot), Storage, and Realtime when configured. Sign-in uses the app's own session store, not Supabase Auth.
- Optional Stripe Checkout in test mode
- One Next.js app serves the screens and the API, deployed together on Vercel

## Roles

Roles follow least privilege and separation of duties. The single source of truth is [src/lib/policy.ts](src/lib/policy.ts).

| Email | Role | Can do |
| --- | --- | --- |
| customer@acme-retail.test | Customer | Shop, cart, checkout, own orders, tracking, cancellation before shipment, returns |
| catalog@acme-retail.test | Catalog | Products |
| warehouse@acme-retail.test | Warehouse | Inventory and fulfillment (delivery updates follow the delivery state machine) |
| finance@acme-retail.test | Finance | Orders (read), refunds, and staff cancellations that refund |
| admin@acme-retail.test | Administrator | Simulation settings and read-only oversight of orders, inventory, refunds, and events |

There are also customer accounts `jordan.lee@acme-retail.test` and `sam.patel@acme-retail.test`. Staff accounts cannot place orders, and nobody can refund or cancel-with-refund an order they placed.

No password is shipped with the code. Set `ACME_SEED_PASSWORD` (it must pass the password policy) before the first start: every seeded account signs in with it once and must then choose its own password. Without it the seeded accounts cannot sign in. Data written by earlier versions loses the old shared demo password on first load; reset it by e-mail or re-seed.

## Run locally

```bash
pnpm install
cp .env.example .env.local   # set ACME_SEED_PASSWORD; MAIL_TRANSPORT=console shows reset e-mails in the terminal
pnpm dev
```

Open http://localhost:3000. The first request creates `.data/acme-retail.json` with 40 products and 60 orders (owner-only permissions). Reloading the page keeps that data.

Useful paths:

- `/` home, `/catalog`, `/product/[slug]`, `/cart`, `/checkout`
- `/payment/result`, `/account`, `/account/orders`, `/account/orders/[id]`, `/account/returns`
- `/login`, `/recover`, `/reset`, `/account/profile`, `/account/settings` (password and two-step verification), `/account/privacy` (consents and restrictions), `/privacy` (privacy notice)
- `/office/products`, `/office/inventory`, `/office/orders`, `/office/refunds`, `/office/scenarios`, `/office/audit`

Coupons: `WELCOME10`, `SAVE5`, `FREESHIP`. Standard shipping is free over $75. Tax is an illustrative 8.25% and is not charged on shipping.

Checkout reserves stock for 15 minutes and stores the variant price on the order. Simulated outcomes are approved, declined, authentication required, and timeout. Payment status and delivery status are updated separately. Refunds can be full or partial.

Demo-only features (the customer picks the simulated payment outcome; administrators change the default scenario, advance shipments, and reset the seed from `/office/scenarios`) are on outside production and off in production unless `ACME_DEMO_MODE=enabled`. A reset keeps the audit trail.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
BASE_URL=http://localhost:3000 pnpm test:smoke   # against a running `pnpm start`
```

`.github/workflows/ci.yml` runs the same steps plus `pnpm audit` on every push and pull request. Dependabot proposes dependency and action updates weekly.

## Configuration

Security settings are configuration as code in [src/lib/config.ts](src/lib/config.ts): each setting lists its purpose, options, secure default, security relevance, operational impact, and related settings, and out-of-range values fall back to the secure default. The main variables are in `.env.example`: `ACME_SEED_PASSWORD`, `APP_ORIGIN`, `MAIL_TRANSPORT`/`MAIL_WEBHOOK_URL`/`MAIL_WEBHOOK_TOKEN`, `ACME_DEMO_MODE`, the password policy (`PASSWORD_MIN_LENGTH`, `PASSWORD_REQUIRE_CLASSES`, `PASSWORD_HISTORY`, `PASSWORD_MAX_AGE_DAYS`, `PASSWORD_MIN_AGE_HOURS`, `PASSWORD_BLOCKLIST`), lockout (`AUTH_LOCKOUT_*`), sessions (`SESSION_*`), and the keys `ACME_DATA_KEYS` (data encryption, required in production), `ACME_AUDIT_KEY` (audit trail HMAC) and `STRIPE_WEBHOOK_SECRET_PREVIOUS` (only during a webhook secret rotation). `ACME_DATA_DIR` moves the local data directory.

## Supabase

1. Create a Supabase project.
2. Run [supabase/migrations/001_retail.sql](supabase/migrations/001_retail.sql) in the SQL editor.
3. Copy `.env.example` to `.env.local` and fill in the project URL, anon key, and service role key.
4. Restart `pnpm dev`.

When both `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, the API loads and saves the store snapshot in `retail_state` and mirrors order status into `order_feed`. A failed database read stops the request instead of falling back to local data. Row level security is enabled. There is no client write policy: the Next.js API authorizes the actor, then uses the service role. Return photos go to the private `return-photos` bucket and are referenced only by opaque ids. Without Supabase, photos are stored under `.data/uploads`.

The service role key must stay on the server. Do not prefix it with `NEXT_PUBLIC_`.

Password recovery sends a one-time link, valid for 30 minutes, only to the e-mail address registered on the account (`MAIL_TRANSPORT`). Only a hash of the token is stored, the token travels in the URL fragment, the answer never says whether the account exists, and a confirmation e-mail is sent after any password change.

## Stripe test mode

Set `STRIPE_SECRET_KEY` to a key that starts with `sk_test_` and `APP_ORIGIN` to the site's https origin. Checkout then offers Stripe test checkout. The webhook route is `/api/webhooks/stripe` and rejects requests whose `Stripe-Signature` does not match `STRIPE_WEBHOOK_SECRET`. A verified `checkout.session.completed` event captures the reserved stock. Live secret keys are not accepted.

## Deploy on Vercel

The web screens and API are the same Next.js project. There is no separate API service to deploy.

1. Push the repository to GitHub.
2. Import it in Vercel. The install command is `pnpm install` and the build command is `pnpm build`.
3. Add the environment variables from `.env.example` in the Vercel project settings. Use the Supabase service role only as a server variable.
4. Deploy. Vercel serves both the pages and `/api/*`.
5. Point the Stripe webhook, if used, at `https://YOUR_DOMAIN/api/webhooks/stripe`.

The local JSON file is not durable on Vercel. Production persistence requires the Supabase variables.

## Security notes

Implemented in this repository and covered by the automated tests:

- Authorization: one policy module (roles, separation of duties, object ownership), an explicit allow-list of API routes and pages with deny by default, and server-side page checks in `src/proxy.ts`.
- Authentication: scrypt (N=2^17, r=8, p=1, versioned with rehash on sign-in), password policy with history, blocked words and context checks, lockout after 5 failures with exponential back-off, identical answers and timing for unknown accounts, 30-minute idle and 12-hour absolute sessions, logout that clears browser data.
- CSRF: every state-changing request carries an anti-CSRF token in `X-CSRF-Token` (salt + HMAC-SHA256 of a per-browser secret kept in an HttpOnly, SameSite=Strict `__Host-` cookie, replaced at sign-in; `src/lib/csrf.ts`), on top of the same-origin rules chosen with the SD Elements T1541 flowchart (JSON or a custom header, mandatory matching `Origin`, Fetch Metadata).
- Additional authentication: profile changes, refunds, staff cancellations, product e-mails and simulation actions need a recent step-up (10 minutes). Staff must use TOTP two-step verification (RFC 6238, codes never reused, one-time recovery codes); customers use it or re-enter their password. A step-up issues a new session ticket.
- Privacy: the privacy register in `src/lib/privacy.ts` drives the notice (`/privacy`, summary and details), the separate consent form with Accept and Decline (`/account/privacy`) and the server checks. Checkout and profile accept personal data only after the current notice is accepted; optional uses (product e-mails, delivery phone) need an explicit opt-in, can be withdrawn at any time and stop at once; customers can restrict optional activities, including the realtime order feed. Every decision is stored with items, notice version, language, time and session.
- Headers: nonce-based CSP without `unsafe-inline` and with violation reports to `/api/csp-report`, HSTS, `no-store` on confidential pages, `Secure` + `HttpOnly` cookies.
- Input and load: size limits before parsing, strict UTF-8 and control-character checks, typed schemas, rate limits per IP, per route and per account (sign-in, recovery, reset and MFA counters are shared through the database, so they hold across instances and restarts), a proof-of-work anti-automation check on the password reset page, and load shedding (503) when the event loop stalls.
- Data exposure: lists are paginated and filtered on the server with maximum page sizes and hard caps (`src/lib/query-limits.ts`); every API route has a strict response schema and responses that break it are never sent (`src/lib/api-contract.ts`).
- Encryption at rest: the data snapshot and return photos are sealed with AES-256-GCM using `ACME_DATA_KEYS` (required in production). Keys, purposes, rotation and revocation are listed in `src/lib/keys.ts` and checked at start-up.
- Logging: a separate security log channel (authentication, authorization, CSRF, rate limits, validation, sessions, uploads, administrator actions, start-up), a `db` channel with every commit, rollback and Supabase command, an audit record for every state-changing call, a hash-chained audit trail (HMAC with `ACME_AUDIT_KEY`) that administrators verify read-only at `/office/audit`, and error ids instead of details.
- Release checklist: `src/lib/release.test.ts` (run in CI) fails the build on demo or debug features enabled in production, dead modules, debug statements, unreferenced public assets, test helpers in application code or secrets in `.env.example`; production publishes no browser source maps.

Not verified in this workspace: hosted Supabase and Vercel settings (TLS, network rules, backups, database roles, native database logging), the secret store holding the keys, SPF/DKIM/DMARC for e-mail, penetration testing, and operational monitoring.

The SD Elements project ACME Retail tracks these controls. Each status note is written in Brazilian Portuguese and English and signed RafahMarinho with Agentic AI.
