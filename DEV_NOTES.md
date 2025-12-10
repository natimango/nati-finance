# NATI Accounting - AI Parsing + Metrics Notes

## Schema updates
- `documents`: added `ocr_text` (TEXT), `parsed_json` (JSONB), and status field reused for AI pipeline states.
- Existing accounting tables (bills, vendors, bill_items, payments, journal entries, drop budgets) remain unchanged.

## AI parsing abstraction
- `src/services/aiParser.js` wraps providers:
  - `AI_PROVIDER=openai` (default) uses the OpenAI client.
  - `AI_PROVIDER=heuristic` uses regex/heuristic fallback.
- All providers normalize to a ParsedInvoice-like object; controllers just call `parseInvoiceText`.

## OCR + parsing flow
1. Upload → document row created (`status=uploaded`).
2. Preprocess (OCR) saves raw text into `documents.gemini_data` (legacy column) and `notes`; status not forced here.
3. Parsing step calls `parseInvoiceText(rawText, { filePath, fileType })`:
   - On success: update `documents.gemini_data` with parsed data + `_provider`, `_fallback`; link/create vendor; create bill/bill_items; set status to `processed/parsed`.
   - On failure: mark `status=manual_required` (or `failed`), keep notes.

## Metrics endpoints
- `GET /api/metrics/summary`: docs by status, spend by vendor, spend by category (date range optional).
- `GET /api/metrics/cogs/:sku_code`: aggregates bill_items for a SKU over a period.
- Existing reports endpoints remain intact.

## How to run
- Migrations: `psql -d nati_accounting -f src/migrations/007_documents_ai_fields.sql` (and prior migrations already applied).
- Start server: `npm start` (uses `.env`).
- Upload/parse: use existing upload endpoint; documents/listing routes show status/provider badges.
- Switch AI providers:
  - `AI_PROVIDER=openai` (default, requires `OPENAI_API_KEY`)
  - `AI_PROVIDER=heuristic` (local regex-based)
  - Location: `src/services/aiParser.js`

## Notes
- OCR (Tesseract) is heavy; keep async and consider a worker if scaling.
- Provider info is stored on parsed data (`_provider`, `_fallback`) and shown in UI badges.
