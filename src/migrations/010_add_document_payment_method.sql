-- Add payment_method to documents to surface chosen method even before bill is created
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'UNSPECIFIED';

CREATE INDEX IF NOT EXISTS idx_documents_payment_method ON documents(payment_method);
