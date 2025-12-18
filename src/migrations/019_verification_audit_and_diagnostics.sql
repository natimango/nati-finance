BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by_user_id INT,
  ADD COLUMN IF NOT EXISTS verification_source TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS page_count INT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ai_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_verification_status ON documents(verification_status);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_quality_score ON documents(quality_score);

DO $$
DECLARE
  col_name TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='documents' AND column_name='uploaded_at'
  ) THEN
    col_name := 'uploaded_at';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='documents' AND column_name='created_at'
  ) THEN
    col_name := 'created_at';
  ELSE
    col_name := NULL;
  END IF;

  IF col_name IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_documents_needs_review_ts ON documents(%I) WHERE verification_status = %L;',
      col_name, 'needs_review'
    );
  END IF;
END $$;

COMMIT;
