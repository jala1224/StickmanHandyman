# Stickman Handyman

This repository contains the static marketing site and the first backend scaffold for the client/admin portal.

## Current layout

- Static site: `home.html`, `gallery.html`, `contact.html`, shared components, images, and deployment scripts
- Backend scaffold: `backend/`

## Backend quick start

1. Copy `backend/.env.example` to `backend/.env`.
2. Install backend dependencies inside `backend/`.
3. Run the API with `npm run dev` from `backend/`.

The first backend version includes:

- Admin login
- Anonymous client lookup by name and address
- CRUD endpoints for clients, invoices, and contracts
- Dashboard summary data
- Placeholder env settings for Stripe and email integration