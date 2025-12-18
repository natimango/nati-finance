BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE document_field_history
  ADD COLUMN IF NOT EXISTS operation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS source_action TEXT;

CREATE INDEX IF NOT EXISTS idx_dfh_document_id_created_at
  ON document_field_history(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dfh_operation_id
  ON document_field_history(operation_id);

COMMIT;
