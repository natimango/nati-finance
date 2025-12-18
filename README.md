# NATI Accounting

Modern accounting ops stack for NATI’s finance team. The app ingests invoices via OCR, normalises them with a two-stage AI pipeline, and exposes workflows (documents, drops, reports, alerts) through a static frontend and JSON APIs.

---

## Stack & Architecture

| Layer | Details |
| --- | --- |
| Runtime | Node.js 20, Express (CommonJS) |
| Database | PostgreSQL 15 (SQL migrations in `src/migrations/`) |
| Frontend | Static HTML/JS/Tailwind served from `public/` |
| OCR | Tesseract + Sharp preprocessing, cached per document |
| AI Parsing | Pluggable providers in `src/services/aiParser.js` (`heuristic`, `openai`) |

Requests hit `src/server.js`, flow through `src/routes/*`, and execute controller/service logic that persists to Postgres and surfaces status back to the UI.

---

## Highlight Features

- **Upload → OCR → AI parsing** with automatic vendor/date/total extraction, caching, and manual override support.
- **Document ops UI** (`public/documents.html`) with filters, verification badges, manual entry, and reprocess actions.
- **Verification workflow** (processing → unverified → needs_review → verified) with evidence snippets, locks, audit trails, and alert counts.
- **Drop budgeting dashboard** plus reports (P&L, trial balance, balance sheet, COGS per SKU, metrics).
- **Alerts engine** for stale docs, unpaid >30d, duplicate spend, drop budget variance, and verification issues.
- Duplicate file hash detection now surfaces `DOC_DUPLICATE_FILE` alerts so operators are notified when the same PDF/capture is re-uploaded, and the dashboard badges it alongside the other verification signals.
- **Two-stage extraction contract**: heuristics produce candidates, OpenAI validates/fills blanks only when evidence meets confidence thresholds.
- **Full history** via `document_field_history`, including actor type, confidence, and evidence.

---

## Project Layout

```
src/
  server.js               # Express bootstrap, static asset serving
  config/database.js      # pg Pool configuration
  routes/*.js             # API route definitions (upload, bills, reports, brain)
  controllers/*.js        # Business logic
  services/
    aiParser.js           # Provider orchestrator (heuristic + OpenAI)
    ruleExtractor.js      # Stage A heuristics (candidates, flags, evidence)
    openaiService.js      # Stage B prompts
    preprocessService.js  # OCR preprocessing + caching
  migrations/*.sql        # Schema
  utils/ocrCache.js       # Store/read raw text, hashes, versions
  utils/documentAudit.js  # Field history logging
public/
  documents.html          # Documents list + verification badges
  upload.html, drop.html, reports.html, js/*
uploads/                  # Stored files (mounted volume in Docker)
```

---

## Environment Configuration

Create `.env` (and `.env.docker` for Compose) with:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for the API server. |
| `PORT` | Express port (defaults to `3000`). |
| `AI_PROVIDER` | `openai` (default) or `heuristic`. Controls Stage B provider. |
| `OPENAI_API_KEY` | Required when `AI_PROVIDER=openai`. |
| `JWT_SECRET` | Session + token signing secret. |
| `SYSTEM_USER_ID` | `users.user_id` used for system-created journal entries. |
| `UPLOAD_IMAGE_MAX_DIM` | Optional Sharp resize bound (px). |
| `UPLOAD_IMAGE_JPEG_QUALITY` | Optional JPEG quality (0-100). |
| `OCR_VERSION` | Integer cache version; bump to force re-OCR. |
| `OCR_TEXT_MIN_LEN` | Raw text length gate before running AI (default 200). |
| `MAX_AI_CALLS_PER_MIN` | Budget limiter for OpenAI calls (default 8). |
| `MAX_AI_OCR_LENGTH` | Hard cap on characters sent to AI (default 12k). |
| `VERIFY_CONF_THRESHOLD` | Minimum confidence (0–1) + evidence check before overwriting unlocked fields (default `0.85`). |

`.env.docker.example` shows the minimal keys for Compose. Never commit secrets.

---

## OCR Cache & Evidence Pipeline

1. **Upload** stores the raw file in `uploads/` and inserts a `documents` row (`status=processing`).
2. **Preprocess (`preprocessService`)**:
   - Figures out MIME type, optimises images via Sharp, and extracts text.
   - For PDFs, attempts `pdf-parse`; if unusable, rasterises pages (~300 DPI) and runs Tesseract.
   - Stores `raw_text`, `raw_text_hash`, engine metadata, and `ocr_version` in Postgres via `utils/ocrCache`.
   - Skips OCR when file hash + version already exist.
3. **Stage A heuristics (`ruleExtractor`)**:
   - Tokenises text and emits candidate arrays for vendor, bill date, totals.
   - Each candidate includes confidence, evidence snippet, source, and ambiguity flags.
   - Result stored inside `documents.extraction_state.heuristics`.
4. **Stage B AI (`aiParser` / `openaiService`)**:
   - Only triggered when heuristics miss/ambiguous, when throttling allows, and when `AI_PROVIDER` permits.
   - Prompt includes the top candidate hints; output must be strict JSON with `value/confidence/evidence` for each field.
   - Controller merges AI output only when `confidence ≥ VERIFY_CONF_THRESHOLD` **and** evidence exists verbatim in the OCR text.
5. **Verification snapshot (`buildVerificationSnapshot`)** flattens heuristics + AI data into an object consumed by the frontend:

```json
{
  "status": "processing|unverified|needs_review|verified",
  "quality_score": 0-100,
  "bill_date_locked": true|false,
  "total_locked": true|false,
  "bill_date_source": "ai|heuristic|manual|stored",
  "total_source": "ai|heuristic|manual|stored",
  "bill_date_evidence": "string or null",
  "total_evidence": "string or null",
  "reason": "Ambiguous total" // only when status=needs_review
}
```

6. **Audit trail (`document_field_history`)** records every automated or manual change with actor, confidence, and evidence.

---

## Verification Workflow

| Status | When it’s set | Typical action |
| --- | --- | --- |
| `processing` | OCR/AI not finished or no raw text yet. | Wait / check worker logs. |
| `unverified` | Date & total present, no outstanding flags. | Optional review. |
| `needs_review` | Missing/ambiguous date/total, low quality, AI failure, or manual flag. | Manual entry or re-run AI. |
| `verified` | Date & total present **and** locked/confirmed (manual lock or previous verified state). | No action needed. |

Documents with `needs_review` power filter chips in the UI and feed alert counts (e.g., missing date for >24 h, high-value docs lacking totals, low `quality_score`). Locks (`bill_date_locked`, `total_locked`) plus “re-run AI” button ensure manual corrections never get overwritten.

The dashboard and documents list consume `/api/documents` (full objects) or `/api/documents/verification/summary` (counts only).

---

## Core Flows

1. **Upload & Auto-Process**
   - Endpoint: `POST /api/upload` (see `public/upload.html` form).
   - Validates category, payment method, drop name; saves file; kicks off `processDocumentWithAI`.
   - Background job handles OCR, Stage A/B, vendor creation, bill upsert, payment schedule, journal entries.

2. **Documents UI**
   - `public/documents.html` fetches `/api/documents`.
   - Displays verification badge + tooltip (reason, evidence, locks, quality score).
   - Modal actions: download, delete, re-run AI (`POST /api/upload/documents/reprocess`), manual entry (`POST /api/bills/:document_id/manual`).

3. **Manual Processing**
   - Validates vendor info, totals, category, payment terms, locks fields.
   - Sets `gemini_data.manual` flag so future AI runs skip the document.

4. **Reports & Drops**
   - `/api/reports/*` endpoints remain unchanged; drop cost overview pulled by `public/drop.html`.

5. **Alerts (home dashboard)**
   - Uses verification statuses + budgets to surface duplicates, stale docs, unpaid >30 d, exceeded budgets, high-risk verification gaps.

---

## Running Locally

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Configure env**
   - Copy `.env.example` if available or create `.env` with the variables listed earlier.
   - Ensure `DATABASE_URL` points to a reachable Postgres instance.
3. **Apply migrations**
   ```bash
   psql -d <db> -f src/migrations/015_ocr_caching.sql
   psql -d <db> -f src/migrations/016_extraction_state_and_history.sql
   psql -d <db> -f src/migrations/017_verification_lock_columns.sql
   psql -d <db> -f src/migrations/018_file_hash.sql
   psql -d <db> -f src/migrations/019_verification_audit_and_diagnostics.sql
   psql -d <db> -f src/migrations/020_document_field_history_operation_id.sql
   psql -d <db> -f src/migrations/021_file_hash_backfill.sql
   # (and any earlier migrations if setting up from scratch)
   ```
4. **Start dev server**
   ```bash
   npm run dev   # nodemon src/server.js
   ```
5. **Create initial admin**
   ```bash
   npm run create:admin founder@nati.in VeryStrongPassword admin "Finance Admin"
   ```
6. Visit `http://localhost:3000/login.html`, sign in, and exercise the workflows.

> Tip: keep `AI_PROVIDER=heuristic` when running locally to avoid OpenAI calls. Switch to `openai` only when credentials are available.

## Nightly verification worker

`npm run nightly:verify` executes `scripts/nightlyVerification.js`, which re-runs the AI extraction for documents stuck in `needs_review`/`unverified` (or missing a bill date/total) while respecting the per-document retry cap; drop it into your cron/Dokku schedule so the verification loop remains automatic. Set `NIGHTLY_REVERIFY_LIMIT`/`NIGHTLY_REVERIFY_DAYS` in your `.env` (defaults: 25 docs, 30 days) to tune how much it scans in one pass.

---

## Docker (Local or Production)

`docker-compose.yml` builds the app image + spins up Postgres with persistent volumes:

```bash
cp .env.docker.example .env.docker   # fill in secrets
docker compose up --build -d
docker compose logs -f app           # follow app logs
docker compose logs -f db            # follow Postgres logs
docker compose down                  # stop everything
```

Volumes:
- `pg-data` → Postgres data directory
- `uploads-data` → `/app/uploads` (invoice files)

### Applying migrations in Docker

```bash
docker exec -i nati-accounting-db \
  psql -U nati_admin -d nati_accounting < src/migrations/017_verification_lock_columns.sql
```

Repeat per migration file.

---

## Production Deployment (Docker Host)

Typical deploy on a droplet (e.g., `accounts.natiwear.in`):

```bash
ssh root@<droplet-ip>
cd /root/nati-finance
git pull origin main

# Apply any new migrations
docker exec -i nati-accounting-db psql -U nati_admin -d nati_accounting < src/migrations/018_file_hash.sql

# Rebuild + restart stack
docker compose down
docker compose up --build -d

# Verify
docker ps
curl -s http://localhost:3000/api/health
```

The compose file already mounts `uploads` and uses `.env.docker`. Adjust secrets there (OpenAI key, JWT secret, etc.) before bringing the stack up.

---

## Useful Commands & Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Express via nodemon for hot reload. |
| `npm start` | Production start (`node src/server.js`). |
| `npm test` | Placeholder (currently echoes “No tests yet”). |
| `npm run create:admin <email> <password> <role> "<name>"` | Seed an admin/manager/uploader user. |
| `docker compose logs -f app` | Tail app container logs (production). |

---

## Troubleshooting

- **AI skipped / throttled**: check `MAX_AI_CALLS_PER_MIN`, `MAX_AI_OCR_LENGTH`, and logs. Heuristic fallback kicks in automatically.
- **Verification stuck in `processing`**: ensure `raw_text` exists (OCR version matches, hashes align). You can trigger `/api/upload/documents/reprocess` for the document scope.
- **Manual overrides overwritten**: confirm `bill_date_locked` / `total_locked` in the DB, or set locks by editing the document manually. Locked fields are never overwritten by AI.
- **OCR cache stale after model changes**: bump `OCR_VERSION` env or clear `raw_text_hash` to force re-OCR.

---

## Health Check

`GET /api/health` returns DB connectivity + basic stats.

Authentication is required for most API routes; log in via the UI to obtain cookies/tokens.

---

Happy accounting! Reach out to the finance platform team for infra credentials or pipeline tweaks. All code changes should be accompanied by migrations (when schema updates are required) and tested locally or via Docker before pushing to production.***
