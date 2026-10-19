# Stickman Handyman

This repository contains the marketing website, customer and admin portals, and the Node.js API for invoices, maintenance contracts, and contractor tracking.

## Current layout

- Static frontend: root HTML pages, `styles.css`, `portal-shared.js`, shared components, and assets
- Styles: `styles.css` contains the site base; `css/navigation.css` and `css/pdf-viewer.css` contain shared components; remaining `css/` files contain page-specific rules. Keep static styles out of HTML.
- Scripts: `js/` contains page scripts; `js/admin/` separates invoice, contractor, client, and contract functions. Admin feature scripts load before `js/portal-admin.js`, which owns shared state, startup, and event wiring. These are ordered classic scripts, not independent ES modules.
- Backend API: `backend/src/`, with local JSON persistence in `backend/data/`
- Deployment configuration: `deploy-to-s3.ps1` for the frontend and `backend/deploy/` for the API host
- Invoice templates and fonts: `invoice_template/` and `fonts/`

## Backend quick start

1. Copy `backend/.env.example` to `backend/.env`.
2. Install backend dependencies inside `backend/`.
3. Run the API with `npm run dev` from `backend/`.

The backend includes:

- Admin login
- Anonymous client lookup by name and address
- CRUD endpoints for clients, invoices, and contracts
- Contractor hours, invoice billing rates, and separate contractor pay rates
- Generated invoice PDFs
- Dashboard summary data
- Stripe invoice payments and maintenance-contract subscriptions

## Validation

After installing backend dependencies, run these from either the project root or `backend/`:

```bash
npm run check
npm test
npm run verify
```

`check` syntax-checks frontend, backend, tests, and tooling; verifies HTML asset references and script declaration compatibility; and rejects embedded CSS or executable inline JavaScript. `test` runs the regression suite. `verify` runs both.

Financial tests use temporary storage and never load local business records or `.env`. Deployment tests simulate service, dependency-installation, and health commands; they need Bash (Git Bash on Windows) and are skipped when it is unavailable. They never connect to production. Browser checks are still needed for mobile forms, galleries, PDF rendering, and downloads.

## Local Frontend

Install dependencies with `npm --prefix backend ci`, then run `npm run dev` at the project root. This starts both the API and frontend; open `http://127.0.0.1:8080/portal-login.html`.

- Local admin email: `admin@local.test`
- Local admin password: `local-dev-only` (development only, never a production credential)
- Local test records: `.local/data/`; generated PDFs: `.local/invoices/`. Both are ignored by Git and excluded from frontend deployments.
- First run seeds an $80/hour owner, a $50/hour sample contractor, and the API's sample client. Subsequent runs keep your local test changes.
- Stripe and email credentials are explicitly disabled by the launcher. It runs the API from `.local/` rather than loading `backend/.env`.
- Both services bind to localhost. Ctrl+C stops both services.

Use `npm run dev -- --port=8127 --api-port=3001` to choose free frontend/API ports. The frontend proxies `/api/` and `/health` to that local backend. `npm run dev:frontend` starts only the frontend when you want to run the backend separately (`API_PORT` selects its proxy port). These servers are for development, not production.

### Automatic API Selection

Pages served from `localhost`, `127.0.0.1`, or IPv6 loopback use their own origin and the local API proxy. Published pages automatically use `https://api.stickman-handyman.com`, even if an old browser setting points elsewhere. You do not edit URLs before publishing. Browser API overrides apply only to `file://` previews.

Pushing a Git branch does not itself deploy the website or API; use the release procedures after testing. Production storage paths remain unchanged unless explicitly configured through `STICKMAN_DATA_DIR` or `STICKMAN_INVOICES_DIR` on the API host.

## Deployment

The frontend is served by S3 and CloudFront. The API runs separately on EC2 behind nginx as `stickman-handyman.service`. The S3 deploy script does not update or restart the backend.

See [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md) for frontend deployment and the backend release checklist. See [backend/README.md](backend/README.md) for API setup and endpoints.

## Private Files

Keep `.env` files, SSH private keys, generated invoice PDFs, and `backend/data/` out of Git and frontend uploads. Use `backend/.env.example` for configuration names only, never real credentials. Back up production runtime data before backend releases; local data must not overwrite production records.