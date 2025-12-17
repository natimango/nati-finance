-- Add structured extraction metadata and quality scoring
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS extraction_state JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS quality_score INTEGER;

-- Add lock flags so manual edits can’t be overwritten
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS bill_date_locked BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_locked BOOLEAN DEFAULT FALSE;

-- Track every automated/manual change for auditing
CREATE TABLE IF NOT EXISTS document_field_history (
  history_id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_type TEXT NOT NULL, -- e.g., 'user', 'system', 'ai'
  actor_id INTEGER,
  reason TEXT,
  confidence NUMERIC,
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_field_history_document_id
  ON document_field_history (document_id);
