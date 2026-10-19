# Stickman Handyman Backend

This folder contains the first backend implementation for admin/client portal support.

## What it includes

- Admin login endpoint with session-token protection for admin routes
- Anonymous account lookup by name + address
- Optional client account activation with email/password for notifications and autopay-ready features
- CRUD endpoints for accounts, invoices, and contracts
- Maintenance package type and level fields on contracts, including custom monthly cost, retainer/rollover hours, discount, and included services
- Contractor profiles, invoice-assigned hours, and ongoing job tracking
- Dashboard summary endpoint
- Audit log hooks for record changes
- Stripe Checkout for one-time invoices and contract payments, plus recurring contract autopay
- PostgreSQL schema for account-based records in `db/schema.sql`

## Local development

1. Copy `.env.example` to `.env`.
2. Install dependencies in this folder.
3. Start the API:

```bash
npm install
npm run dev
```

## Endpoints

- `GET /health`
- `POST /api/auth/login`
- `POST /api/client-auth/activate`
- `POST /api/client-auth/login`
- `GET /api/client-auth/me`
- `PATCH /api/client-auth/me` updates the signed-in client's name and address.
- `PATCH /api/client-auth/preferences`
- `GET /api/dashboard/summary`
- `GET /api/clients`
- `POST /api/clients`
- `PUT /api/clients/:clientId`
- `POST /api/clients/lookup`
- `GET /api/invoices`
- `POST /api/invoices`
- `PATCH /api/invoices/:invoiceId`
- Ongoing jobs are created through `POST /api/invoices` with `isOngoing: true` and a `jobName`; they have no invoice number or PDF until patched with `isOngoing: false`.
- `POST /api/invoices/:invoiceId/lookup-access`
- `GET /api/contracts`
- `POST /api/contracts`
- `PATCH /api/contracts/:contractId`
- Signed-in clients can start a one-cycle payment with `POST /api/contracts/:contractId/checkout-session` and `{"autopay":false}`.
- Signed-in clients can start recurring billing with the same endpoint and `{"autopay":true}`; the interval follows the contract's monthly, quarterly, or annual billing cycle.
- `POST /api/contracts/:contractId/checkout-session/confirm` verifies the successful Checkout return.
- `POST /api/contracts/:contractId/autopay/cancel` cancels a contract subscription.
- Configure Stripe to send `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted` events to `/api/stripe/webhook`.
- Contract numbers are assigned automatically from `CONTRACT_NUMBER_START` and the highest saved contract number.
- Contracts accept package types `single_home`, `portfolio`, or `custom`; standard packages use levels `basic`, `pro`, or `premium`, while custom packages save their own pricing, hours, discount, and included-service flags.
- `GET /api/contractors`
- `POST /api/contractors`
- `PATCH /api/contractors/:contractorId`
- `POST /api/contractors/:contractorId/time-entries`
- `DELETE /api/contractors/time-entries/:timeEntryId`
- `GET /api/contractors` includes invoice-linked payment transactions.
- `PATCH /api/contractors/payments/:paymentId` updates a contractor payment's paid status.

## Notes

Client profiles, invoices, and contracts are persisted in `data/business.json`, including contract package selections. Contractor profiles, ongoing jobs, invoice-linked contractor-hour snapshots, and per-invoice contractor payment transactions are persisted in `data/contractors.json`; payment transactions retain actual contractor pay rates and paid status. The admin contractor list seeds an editable `Owner (You)` record on first run. Back up the `data` directory. Client login sessions remain in-memory. The PostgreSQL schema foundation remains in `db/schema.sql`.

## Client activation flow

1. The client finds their account through name + address lookup.
2. The frontend can then offer account activation using the returned `accountKey`, plus the same name and address, email, and a password.
3. Once activated, the client can log in and later manage notification or autopay preferences.

For a production billing flow, replace direct self-activation with an email verification or invite token before enabling autopay.

## Billing model

1. One-time invoices should not require an email/password account.
2. Anonymous name + address lookup is enough to view eligible invoices and begin a one-time Stripe payment.
3. Stripe should collect the payment details and receipt email for one-time payments.
4. Contract payments and autopay require a signed-in client account.

## Planned one-time invoice payment flow

1. The customer enters name and address on the Account page.
2. The backend verifies the lookup and returns matching invoices plus a short-lived lookup access token.
3. The customer selects an unpaid invoice.
4. The frontend sends the invoice id and lookup access token to the backend.
5. The backend validates that token against the account behind the invoice, confirms the invoice is payable, and creates a Stripe Checkout Session.
6. Stripe handles card entry and receipt email collection.
7. After payment, Stripe calls the webhook and the backend marks the invoice as paid.

The short-lived lookup access token is important. Without it, a public payment endpoint keyed only by invoice id would be too weak.

The current scaffold returns `lookupAccessToken` and `lookupAccessExpiresAt` from `POST /api/clients/lookup`, and exposes `POST /api/invoices/:invoiceId/lookup-access` to validate that the invoice belongs to the previously verified account. Contract subscriptions use the signed-in client session instead.

## Stripe webhook setup

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `backend/.env`. Register the webhook endpoint at `https://<backend-host>/api/stripe/webhook` in Stripe, subscribe to the events listed above, and use its signing secret as `STRIPE_WEBHOOK_SECRET`. For local testing, use Stripe CLI to forward those events to `http://localhost:3000/api/stripe/webhook` and set the CLI-provided signing secret. The signed-in client portal verifies the initial Checkout return; webhooks keep later subscription renewals, failures, and cancellations synchronized.