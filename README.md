# NATI Accounting

## Stack
- Node.js + Express (CommonJS)
- Postgres (SQL migrations in `src/migrations/`)
- Frontend: static HTML/JS/Tailwind in `public/`
- OCR via Tesseract (through `preprocessService`)
- AI parsing abstraction in `src/services/aiParser.js` (pluggable provider)

## Key Features (currently enabled)
- Bill upload + OCR + AI/rule parsing → persists vendor/bill metadata and line items.
- Document listing with filters (date, category, payment method, status, search).
- Calendar filter for documents.
- Manual bill processing form (when AI fails).
- Notion sync: removed.
- Basic reports endpoints (P&L, trial balance, balance sheet, metrics, COGS per SKU).
- Drop budgets with history + variance dashboard and alert engine (duplicates, stale docs, unpaid >30d, budget threshold alerts surfaced on the homepage).
- Drop cost overview endpoint (`GET /api/brain/drop/:dropName/cost`) and UI (`public/drop.html`) showing committed/paid/outstanding and category/vendor/SKU splits.

## Removed/Disabled (per recent cleanup)
- Reconciliation UI and bank-import flows removed.
- Payments UI removed (back-end payment endpoints still exist if needed).
- Series/channel/campaign filters and fields removed from UI and validation.

## Project Structure
- `src/server.js` – Express bootstrap and static file serving.
- `src/config/` – database config.
- `src/routes/` – route definitions (upload, bills, reports, brain).
- `src/controllers/` – business logic (billController, uploadController, reportsController, etc.).
- `src/services/` – AI parser (OpenAI primary, heuristic fallback), OCR preprocessing.
- `src/migrations/` – SQL schema (documents, bills, vendors, line items, payments, journal, budgets, etc.).
- `public/` – UI pages and JS (documents listing, upload, reports dashboard).

## Environment Variables
Create a `.env` with:
```
DATABASE_URL=postgres://user:pass@host:port/db
PORT=3000
AI_PROVIDER=openai          # openai (default) | heuristic
OPENAI_API_KEY=...          # required for openai provider
JWT_SECRET=super-long-random-string
UPLOAD_IMAGE_MAX_DIM=2000   # optional resize limit in pixels
UPLOAD_IMAGE_JPEG_QUALITY=80
SYSTEM_USER_ID=1            # fallback user id for system journal entries
VERIFY_CONF_THRESHOLD=0.85  # min AI confidence (0-1) when auto-applying date/total
```
Adjust keys based on the provider you actually enable.

## Running Locally
```
npm install
npm run dev   # nodemon src/server.js, serves UI at http://localhost:3000
```
Ensure Postgres is running and `DATABASE_URL` points to it.

Create at least one admin account so you can sign in:
```
npm run create:admin founder@nati.in VeryStrongPassword admin "Finance Admin"
```
Then open `http://localhost:3000/login.html`, sign in, and the UI + `/api/*` endpoints will be available based on your role.

## Running with Docker
1. Install Docker Desktop / Docker Engine (Compose v2+).
2. Copy the sample environment file and add your secrets:
   ```
   cp .env.docker.example .env.docker
   # edit .env.docker to add OPENAI_API_KEY, auth creds, etc.
   ```
3. Build and start the stack (app + Postgres) in the background:
   ```
   docker compose up --build -d
   ```
   - App runs on `http://localhost:3000`.
   - Postgres data persists in the `pg-data` volume; bill uploads persist in `uploads-data`.
4. View logs with `docker compose logs -f app` and stop everything with `docker compose down`.

Set different credentials/budgets by editing `docker-compose.yml` (Postgres user/password) and `.env.docker` (OpenAI key, basic auth, AI provider, etc.).

## Migrations
Migrations live in `src/migrations/`. Apply them using your preferred SQL runner (psql, Postgres client) in order. They define documents/bills/vendors/line_items/payments/journal tables and related budget tables.

## Core Flows
- **Upload** (`public/upload.html` → `/api/upload`): stores file (images are resized/compressed via Sharp), runs OCR, then `aiParser.parseInvoiceText` (provider selected by `AI_PROVIDER`). Parsed data persists to documents/bills/line items. Status updates: `uploaded` → `ocr_done` → `parsed` (or `manual_required`/`failed`).
- **Document list** (`public/documents.html`): filters by date, category, payment method, status, search; calendar view; click-to-open modal for actions (download/delete, AI process, manual entry).
- **Manual bill processing**: `POST /api/bills/:document_id/manual` from the modal, saving vendor, amounts, line items, tags, department, payment method.
- **Reports** (backend): `/api/reports/*` for P&L, trial balance, balance sheet, chart of accounts, dimension spend (now drop/channel stripped to “Unassigned” for channel/campaign), metrics summary, COGS by SKU. Marketing/shipment ingest endpoints remain if needed.

## AI Parser
- Entry point: `src/services/aiParser.js` (pluggable via `AI_PROVIDER`).
- Heuristic/default: regex + rule-based parsing on OCR text for zero-cost fallback.
- OpenAI is the only external provider; make sure `OPENAI_API_KEY` is set if you enable it.
- Always designed to fail gracefully and allow manual processing.

## Current UI Notes
- Sidebar links include Dashboard, Documents, Upload, Reports. Payments/Reconciliation/Series pages are removed.
- Drop overview page (`drop.html`) links from the dashboard to show cost-to-market for a chosen drop (defaults to Drop 1).
- Filters include payment method; series/channel/campaign fields are removed from UI.
- Clicking a document opens a modal with quick actions; detail pane is suppressed.

## If You Re-enable Payments/Reconciliation
- Back-end routes still exist for recording payments and schedules; reconciliation and import routes were removed from routing. Reintroduce only if needed and update navigation accordingly.

## Health Check
`GET /api/health` returns DB connectivity and basic stats.

## Development Tips
- Use `npm run dev` for hot reload via nodemon.
- Check console for server start banner to verify it’s running on the expected port.
- Keep AI provider set to `heuristic` for zero-cost local parsing; switch to OpenAI when keys are configured.
