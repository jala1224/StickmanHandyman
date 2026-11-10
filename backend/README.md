# Stickman Handyman Backend

This folder contains the Node.js API for the customer and admin portals.

## What it includes

- Admin login endpoint with session-token protection for admin routes
- Anonymous account lookup by name + address
- Optional client account activation with email/password for notifications and autopay-ready features
- CRUD endpoints for accounts, invoices, and contracts
- Maintenance package type and level fields on contracts, including custom monthly cost, retainer/rollover hours, discount, and included services
- Contractor profiles, invoice-assigned hours, and ongoing job tracking
- Dashboard summary endpoint
- Audit log hooks for record changes
- Embedded Stripe Checkout for one-time invoices and contract payments, recurring contract autopay, and admin invoice payment tracking
- PostgreSQL schema for account-based records in `db/schema.sql`

## Local development

For the isolated full-site sandbox, run `npm run dev` from the project root instead. It starts the frontend proxy plus this API, uses `.local/` records/PDFs, disables live integrations, and provides development-only sign-in credentials documented in [../README.md](../README.md). With Stripe disabled, editing or deleting a sandbox invoice can discard checkout metadata only for an expired, pending test-mode session with no recorded payment intent; other sessions remain protected until Stripe can verify them. This is local test-data cleanup, not confirmation of payment status.

To run this API separately with your own `backend/.env` and the normal `backend/data/` records:

1. Copy `.env.example` to `.env`.
2. Install dependencies in this folder.
3. Start the API:

```bash
npm install
npm run dev
```

Run `npm run verify` to check project syntax/asset references and run isolated billing and simulated deployment tests. See [../README.md](../README.md) for frontend development and [../AWS_DEPLOYMENT.md](../AWS_DEPLOYMENT.md) for the dry-run-first backend release script and rollback limits.

Fresh contractor storage initializes all required collections, including `paymentTransactions`. Regression coverage verifies the first invoice's contractor hours and payment record in an empty temporary data directory. Existing production records are not migrated or rewritten by this initialization fix.

## Endpoints

- `GET /health`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/client-auth/activate`
- `POST /api/client-auth/login`
- `GET /api/client-auth/me`
- `GET /api/client-auth/me/activity` returns only the signed-in account's invoices and contracts, with the same billing summaries as account lookup.
- `POST /api/client-auth/logout`
- `PATCH /api/client-auth/me` updates the signed-in client's name and address.
- `PATCH /api/client-auth/preferences`
- `GET /api/dashboard/summary`
- `GET /api/clients`
- `POST /api/clients`
- `PUT /api/clients/:clientId`
- Client records may include `businesses: [{ name, address }]`; business invoices keep the owning person’s `accountId` and set `billingBusinessId` so access and payment history stay under that client.
- `POST /api/clients/lookup`
- `GET /api/invoices`
- `POST /api/invoices`
- `POST /api/invoices/contract-pricing-preview` accepts the invoice draft and an
  optional `invoiceId` when editing. The preview excludes the existing invoice
  from contract usage/balance calculations and preserves its saved contractor pay
  rates. `isOngoing: true` previews the job subtotal without applying contract
  credits or quote caps until finalization. Unknown invoice IDs return 404;
  invalid pricing inputs return a readable 400 response.
- `PATCH /api/invoices/:invoiceId`
- Invoice PDFs use the selected business name/address for billing while retaining the client account. Portfolio maintenance contracts can match the client’s home, service, and associated business addresses.
- Invoice PDF subtotal, retainer-credit and discount amounts omit currency symbols. Subtotal appears only when a retainer credit or discount is deducted. Downloads render the current layout from invoice data instead of serving older saved PDFs; saved files remain available for invoice numbering and archival storage.
- Ongoing jobs are created through `POST /api/invoices` with `isOngoing: true` and a `jobName`; they have no invoice number or PDF until patched with `isOngoing: false`.
- `POST /api/invoices/:invoiceId/lookup-access`
- `GET /api/contracts`
- `POST /api/contracts`
- `PATCH /api/contracts/:contractId`
- Admins can upload agreement PDFs to `POST /api/contracts/:contractId/attachments?filename=agreement.pdf` as a raw `application/pdf` body (max 10 MB), download them from `GET /api/contracts/:contractId/attachments/:attachmentId`, or remove them with `DELETE` on that route. Files are stored under the private data directory, never in the frontend asset tree, and are removed when the contract is deleted. Client activity responses do not include attachment metadata.
- Admins can create a first-party signing link with `POST /api/contracts/:contractId/attachments/:attachmentId/signature-request` without entering signer details; the client name is taken from the linked account. New links do not require email, while older email-bound requests continue to verify the invited email. Links expire after 14 days, are single-use, and are delivered manually; this application does not send email. Public signing uses `/sign-contract.html` and the `/api/contract-signatures/inspect`, `/document`, and `/complete` endpoints. The signing page loads the same navigation, mobile menu, and footer as the website. The signer reviews the PDF, confirms the client name, selects typed or drawn signature, and explicitly consents. Newly generated agreements store signature-line coordinates in the PDF: completion places the client signature and date on those lines and automatically applies the typed name "Jacob Lancaster" and date on the representative lines, without a printed company attribution or added page. The business signer's name uses italic serif type for presentation; it is still a typed electronic signature, not handwriting or separate representative approval of that exact agreement. Older template PDFs can use their existing Client signature, Stickman Handyman representative, and paired Date labels to locate those same lines without changing the original. Unknown layouts return `SIGNATURE_LINES_NOT_FOUND` instead of appending an audit page; generate a new agreement for those documents. Existing completed PDFs are never rewritten. Dates use America/Denver. Evidence includes signer, optional email, consent, timestamp, IP/user agent, request ID, original-document SHA-256, and business signer name, company attribution, typed method, and signing time in stored metadata, not extra printed PDF data. Token hashes are stored instead of raw tokens, and the token is carried in the URL fragment. This is a basic first-party workflow, not a claim of legal compliance; obtain legal advice about its suitability for your contracts and jurisdiction.
- Maintenance and labor agreements can be generated and sent for signing in one admin action with `POST /api/contracts/:contractId/signature-request`; it renders the saved contract to a type-specific PDF, uses the linked client name, stores that PDF privately, and returns a signing link without requiring an upload or email. Creating a newer generated agreement replaces any pending generated-agreement link for that contract.
- Unsigned generated agreements are private signing sources, not visible Documents entries. They are retained for integrity checks and replay protection, including older generated sources. Once signing completes, only the signed copy appears in Documents, with completion evidence in its metadata. Uploaded files remain visible. Deleting the contract removes both private sources and visible documents.
- After completion, the signing page replaces the unsigned preview with the completed PDF without separate Print, Open PDF, or Download PDF buttons. Signed copies request whole-page fit on desktop and fit-to-width on screens up to 900px, with native toolbars hidden where supported. Phone/tablet layouts use a single column, narrow gutters, and dynamic viewport-based PDF height; native PDF behavior may vary by browser. `POST /api/contract-signatures/signed-document` accepts the same invitation token and any required signer email, requires a completed request, and returns only its matching signed attachment with `Cache-Control: no-store`. The original invitation expiry still applies. Completed links may be reopened for read-only access through `/inspect`; repeat signing remains blocked. If loading fails after a successful signature, the page offers a document-only retry without resubmitting the signature.
- Maintenance contracts offer View on desktop and mobile; `GET /api/contracts/:contractId/pdf` generates their current agreement. Documents > Generate Link stores the same agreement for signing. Standard benefits follow the single-home/portfolio tier; custom benefits follow saved flags. Portfolio agreements cover all maintenance work under the client account without printing property addresses or limiting coverage to addresses on file. Agreements include fees, per-billing-cycle hours, paid-period eligibility, rollover caps, labor-only discounts, the waived two-hour minimum, scheduling/access, exclusions, and approval rules. Quarterly/annual charges multiply the monthly price, not the recorded per-cycle hours. Previously generated or signed attachments are preserved, not rewritten. Cancellation notice, refunds, and minimum commitments are not configured by the application and must be separately agreed; have the template reviewed before client use.
- Admins can manually record the current maintenance billing cycle as paid with `POST /api/contracts/:contractId/record-payment` and undo a manual record with `POST /api/contracts/:contractId/undo-manual-payment`. Undo restores the previous payment date, amount, and due date; it cannot reverse a Stripe payment. The admin tracker offers Mark Paid/Mark Unpaid without confirmation pop-ups. Recording a payment stores the scheduled cycle amount/date, advances overdue due dates, and rejects duplicate payments or active autopay subscriptions. Labor contracts continue to use their invoice-progress tracking.
- Maintenance retainer-hour pools are eligible only after payment is recorded for the invoice’s billing period. Invoices created before that period is paid receive no retainer-hour credit and do not consume the pool later; the period discount behavior is unchanged.
- Signed-in clients can start a one-cycle payment with `POST /api/contracts/:contractId/checkout-session` and `{"autopay":false}`.
- Signed-in clients can start recurring billing with the same endpoint and `{"autopay":true}`; the interval follows the contract's monthly, quarterly, or annual billing cycle.
- Clients without a login can use `POST /api/contracts/:contractId/checkout-session/lookup` with a valid `lookupAccessToken` and `autopay: true` to enroll in the same recurring billing. Omitting `autopay` keeps the one-time payment flow.
- `POST /api/contracts/:contractId/checkout-session/confirm` verifies the successful Checkout return.
- `POST /api/contracts/:contractId/autopay/cancel` cancels a contract subscription.
- Configure Stripe to send `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted` events to `/api/stripe/webhook`.
- Contract numbers use separate sequences from `CONTRACT_NUMBER_START`: maintenance uses the `MCON-` prefix and labor uses `LCON-`. Existing saved contract numbers are preserved.
- Contracts accept package types `single_home`, `portfolio`, or `custom`; standard packages use levels `basic`, `pro`, or `premium`, while custom packages save their own pricing, hours, discount, and included-service flags.
- Custom packages also accept `packageCoverageType: "single_home" | "portfolio"`. The admin custom-package form saves and restores this choice. Missing coverage defaults to single-home for older contracts; standard and custom portfolio coverage shares its hour pool across all maintenance work under the client account, including associated businesses and unlisted job addresses. Single-home coverage remains limited to the contract's service property.
- `GET /api/contractors`
- `POST /api/contractors`
- `PATCH /api/contractors/:contractorId`
- `POST /api/contractors/:contractorId/time-entries`
- `DELETE /api/contractors/time-entries/:timeEntryId`
- `GET /api/contractors` includes invoice-linked payment transactions.
- `PATCH /api/contractors/payments/:paymentId` updates a contractor payment's paid status.

## Notes

Client profiles, invoices, and contracts are persisted in `data/business.json`, including contract package selections. Contractor profiles, ongoing jobs, invoice-linked contractor-hour snapshots, and per-invoice contractor payment transactions are persisted in `data/contractors.json`; payment transactions retain actual contractor pay rates and paid status. The admin contractor list seeds an editable `Owner (You)` record on first run. Back up the `data` directory. Client login sessions remain in-memory. The PostgreSQL schema foundation remains in `db/schema.sql`.

## Mobile app integration

Use the existing API rather than copying billing, retainer/rollover allocation, estimate calculations, or Stripe logic into the app. Existing website endpoints and response fields remain available; the mobile additions are backward-compatible. There is no `/api/v1` alias or generated OpenAPI specification yet; define versioning before making breaking changes after an app release.

### Environments and authentication

- Production API origin: `https://api.stickman-handyman.com`. Local desktop/simulator proxy: `http://127.0.0.1:8080`. On a physical phone, loopback refers to the phone, not the development computer; use a separately configured HTTPS staging API with test-only credentials/data.
- Never bundle Stripe secret keys, webhook secrets, or admin bootstrap passwords into an app. Use the existing ignored local test configuration for backend development. CORS controls browser access, not authorization for native clients.
- Admin login: `POST /api/auth/login`. Client login: `POST /api/client-auth/login`. Both accept JSON `{ "email": "...", "password": "..." }` and return `token` plus numeric `expiresAt` in Unix milliseconds. Tokens are opaque bearer credentials, not JWTs. Client responses include `clientUser`; admin responses include `admin`.
- Store native app tokens in OS secure storage (Keychain/Keystore), and send `Authorization: Bearer <token>` on every authenticated request. Never put bearer tokens in URLs or analytics. Admin/client roles are not interchangeable.
- Use `GET /api/auth/me` for the admin session, or `GET /api/client-auth/me` for the client profile. On `401`, clear that role's token and require login. There is no refresh-token endpoint. Current sessions are in memory and are invalidated by an API restart; persistent session storage is a separate production requirement.
- Logout: `POST /api/auth/logout` or `POST /api/client-auth/logout` with the current bearer token. Both revoke only that role's current session and return `204` with no body, including repeat calls. Do not JSON-decode a `204` response. Guest lookup tokens are separate, short-lived credentials and are not revoked by client logout.

### Account data and payments

The backend supports a gated US Stripe Terminal Tap to Pay integration for native
admin clients. It requires a signed native app, Apple's Tap to Pay entitlement,
a Stripe Terminal location and physical-device verification before use.
Admin-only `/api/terminal` endpoints provide configuration,
connection tokens, invoice PaymentIntent creation, reconciliation and cancellation.
Terminal defaults to disabled; secret keys remain on this backend. The admin
invoice payment-link endpoint continues to use hosted Checkout, with shared
per-invoice locking to serialize online/contactless payment transitions.

1. After client login, call `GET /api/client-auth/me/activity` with the bearer header. It returns `{ "invoices": [...], "contracts": [...] }`, excludes ongoing jobs, and never accepts a caller-selected account ID. The API computes contract balances and pricing summaries.
2. Download/view a client's own invoice using `GET /api/invoices/:invoiceId/pdf` with the same bearer header. The response is binary `application/pdf`; paid invoices remain readable. Other accounts' invoices return `403`. Admin bearer tokens retain PDF access across accounts.
3. Begin invoice Checkout using `POST /api/invoices/:invoiceId/checkout-session` with a client bearer header and `{ "uiMode": "embedded" }` for the website's embedded form or `{ "uiMode": "hosted" }` for hosted Checkout. A lookup token is unnecessary for authenticated clients. Existing guest requests with `lookupAccessToken` still work. An explicitly supplied invalid bearer token is not replaced by a valid guest token.
4. Signed-in contract checkout uses `POST /api/contracts/:contractId/checkout-session` with `{ "autopay": false }` for one-time payment or `{ "autopay": true }` for recurring enrollment; add `uiMode` as above. Guest enrollment remains available through the lookup route.
5. Never infer payment success from the mobile UI, a return URL, or modal closure. Refresh account activity after signed webhooks update the backend. The existing native-oriented `payment-intent` endpoint also accepts client bearer authorization, but a production PaymentSheet/app-link lifecycle and retry strategy must be designed/tested for the chosen app framework. Native Tap to Pay requires a separate Stripe Terminal SDK integration; browser embedded Checkout is not native NFC collection.

Admin apps use the same bearer-protected `/api/clients`, `/api/invoices`, `/api/contracts`, `/api/contractors`, and `/api/dashboard/summary` routes as the admin website. Do not send an admin token through client-only endpoints.

### Responses and retries

- Money is integer cents plus an ISO currency string; display formatting belongs in the app. Hours can contain quarter-hour values. Preserve IDs as strings. Date-only values such as `issueDate` and `startDate` use `YYYY-MM-DD`; timestamps use ISO strings unless explicitly documented as numeric expiry milliseconds. Missing optional fields may be `null` or absent.
- JSON failures retain an `error` string, optionally `details`. Handle `400` invalid input, `401` expired/missing authorization, `403` wrong account/role access, `404` missing record, `409` billing/state conflict, `413` oversized body, `502` provider failure, and `503` missing integration configuration. Unexpected errors return safe JSON rather than exception details.
- API responses include `Cache-Control: no-store` and a server-generated `X-Request-Id`. Capture request IDs for support without logging tokens, payment client secrets, private financial payloads, or query-string lookup tokens. Parser/unexpected-error responses also include `requestId` in JSON.
- Retry safe reads with bounded backoff. Do not blindly retry record creation, invoice finalization, subscription changes, or other writes. Checkout has server-side session-reuse safeguards; there is no general-purpose API idempotency-key contract yet.
- Lists are currently full arrays, not paginated or suitable for large offline sync. Never assume a native app cache is authoritative for payment amounts, invoice status, contract balances, or access permissions.

### Before a public app launch

Add durable sessions/token refresh and password-recovery/verification flows, rate limiting for login and lookup, production database transactions and migrations, paginated/filterable lists, and write idempotency/concurrency control. Current JSON storage and process-local checkout locks target one API process, not multiple workers. Choose client/admin app roles and a framework before implementing universal links, native Stripe PaymentSheet/Terminal, push notifications, or offline synchronization. These changes do not migrate production storage or deploy the API.

## Client activation flow

1. The client finds their account through name + address lookup.
2. The frontend can then offer account activation using the returned `accountKey`, plus the same name and address, email, and a password.
3. Once activated, the client can log in and later manage notification or autopay preferences.

Name/address lookup is not strong identity verification. For stronger protection of billing records, add email verification or invite tokens. Subscription management/cancellation still requires a signed-in client account; lookup access permits payment and enrollment only.

## Billing model

1. One-time invoices should not require an email/password account.
2. Anonymous name + address lookup is enough to view eligible invoices and begin a one-time Stripe payment.
3. Stripe should collect the payment details and receipt email for one-time payments.
4. Contract payments and autopay enrollment permit either a signed-in client session or a valid account lookup token. Managing/canceling autopay still requires sign-in.

## Planned one-time invoice payment flow

1. The customer enters name and address on the Account page.
2. The backend verifies the lookup and returns matching invoices plus a short-lived lookup access token.
3. The customer selects an unpaid invoice.
4. The frontend sends the invoice id and lookup access token to the backend.
5. The backend validates that token against the account behind the invoice, confirms the invoice is payable, and creates a Stripe Checkout Session.
6. Stripe handles card entry and receipt email collection.
7. After payment, Stripe calls the webhook and the backend marks the invoice as paid.

The short-lived lookup access token is important. Without it, a public payment endpoint keyed only by invoice id would be too weak.

The current scaffold returns `lookupAccessToken` and `lookupAccessExpiresAt` from `POST /api/clients/lookup`, and exposes `POST /api/invoices/:invoiceId/lookup-access` to validate that the invoice belongs to the previously verified account. Contract subscription enrollment accepts either a signed-in client session or a valid account lookup token for the same account.

## Stripe webhook setup

Set matching `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` values in the API environment, never in frontend source. Register the webhook endpoint at `https://<backend-host>/api/stripe/webhook` in Stripe, subscribe to the events listed above, and use its signing secret as `STRIPE_WEBHOOK_SECRET`. Also subscribe to `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, and `payment_intent.canceled`.

For isolated integration testing, use test-mode keys, separate `STICKMAN_DATA_DIR` and `STICKMAN_INVOICES_DIR` directories, and Stripe CLI forwarding to `http://localhost:3000/api/stripe/webhook`. Keep production data and credentials out of the test process. The root `npm run dev` sandbox intentionally blanks Stripe credentials, so it displays configuration errors rather than making charges. Automated tests use mocked Stripe sessions and locally signed webhook events, not live Stripe charges.

## Embedded payments and tracking

- Both client views request `uiMode: "embedded"` from the existing checkout endpoints; the API creates `ui_mode: "embedded_page"` sessions and returns a client secret and publishable key. Hosted mode remains the default for older clients.
- Stripe.js loads directly from Stripe. Card details stay in Stripe's embedded fields, not application storage. Use HTTPS in production and configure eligible payment methods and wallet domains in Stripe; Apple Pay/Google Pay visibility depends on the device, browser, account, and Stripe configuration.
- Clients can enable recurring contract autopay inside the payment modal after account lookup, without creating or signing into a login. Lookup sessions must be valid and match the contract's account; inactive contracts and duplicate enrollment are rejected. Stripe collects payment authorization, and signed webhooks update autopay status. The lookup view's **Manage Autopay** action still leads to account activation/sign-in for subscription management.
- Checkout completion refreshes the account but does not mark invoices paid in the browser. Signed webhooks or a server-side admin refresh verify the amount and currency before recording payment. Processing and failure states stay separate from the invoice's paid/unpaid status.
- Admin invoice rows/cards have a **Payments** action for inspecting payment status/errors, refreshing status, and opening the associated Stripe payment. Payment-link creation/sharing and manual phone-payment reconciliation are not available.
- `POST /api/invoices/:invoiceId/stripe-status` refreshes an invoice's saved Stripe session/payment. Editing or deleting an invoice expires its open checkout first; submitted payments must be resolved before changing that invoice. Switching between hosted and embedded checkout also expires the previous open session, invalidating its older URL.
