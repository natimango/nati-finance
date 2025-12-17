ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_file_hash
  ON documents (file_hash);
