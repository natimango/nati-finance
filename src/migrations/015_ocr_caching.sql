ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS raw_text TEXT,
  ADD COLUMN IF NOT EXISTS raw_text_hash TEXT,
  ADD COLUMN IF NOT EXISTS ocr_engine TEXT,
  ADD COLUMN IF NOT EXISTS ocr_version TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verification_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_verification_status
  ON documents (verification_status);
