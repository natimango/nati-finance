-- Add OCR and parsed JSON fields plus richer status
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_text TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parsed_json JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status VARCHAR(50);
