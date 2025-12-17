-- Add missing verification metadata and locks directly on documents
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS verification_reason TEXT,
  ADD COLUMN IF NOT EXISTS bill_date_locked BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_locked BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_by_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

-- Normalize OCR version to integer with a sane default
ALTER TABLE documents
  ALTER COLUMN ocr_version TYPE INTEGER USING NULLIF(regexp_replace(COALESCE(ocr_version::text, ''), '[^0-9]', '', 'g'), '')::INTEGER;

ALTER TABLE documents
  ALTER COLUMN ocr_version SET DEFAULT 1;

UPDATE documents
SET ocr_version = 1
WHERE ocr_version IS NULL;

-- Ensure verification defaults align with the new workflow
ALTER TABLE documents
  ALTER COLUMN verification_status SET DEFAULT 'unverified';

UPDATE documents
SET verification_status = 'unverified'
WHERE verification_status IS NULL
   OR verification_status = ''
   OR verification_status = 'pending';

ALTER TABLE documents
  ALTER COLUMN quality_score SET DEFAULT 0;

-- Carry over any existing lock flags from bills for backward compatibility
UPDATE documents d
SET bill_date_locked = COALESCE(d.bill_date_locked, b.bill_date_locked, FALSE),
    total_locked = COALESCE(d.total_locked, b.total_locked, FALSE)
FROM bills b
WHERE b.document_id = d.document_id;
