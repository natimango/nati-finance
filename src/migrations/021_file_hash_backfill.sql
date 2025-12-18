BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='documents' AND column_name='raw_text_hash'
  ) THEN
    EXECUTE '
      UPDATE documents
      SET file_hash = raw_text_hash
      WHERE file_hash IS NULL AND raw_text_hash IS NOT NULL
    ';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);

COMMIT;
