# Stickman Handyman

This repository contains the marketing website, customer and admin portals, and the Node.js API for invoices, maintenance contracts, and contractor tracking.

## Current layout

- Static frontend: root HTML pages, `styles.css`, `portal-shared.js`, shared components, and assets
- Styles: `styles.css` contains shared rules; `css/<page>.css` contains page-specific rules, loaded after the shared stylesheet. Keep static styles in these files rather than HTML style blocks or attributes.
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

Run `npm run check` from `backend/`. This checks the server entry point's syntax; it is not a full test suite. Static frontend changes also need targeted syntax and browser checks, especially for mobile forms, PDF downloads, and financial summaries.

## Deployment

The frontend is served by S3 and CloudFront. The API runs separately on EC2 behind nginx as `stickman-handyman.service`. The S3 deploy script does not update or restart the backend.

See [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md) for frontend deployment and the backend release checklist. See [backend/README.md](backend/README.md) for API setup and endpoints.

## Private Files

Keep `.env` files, SSH private keys, generated invoice PDFs, and `backend/data/` out of Git and frontend uploads. Use `backend/.env.example` for configuration names only, never real credentials. Back up production runtime data before backend releases; local data must not overwrite production records.