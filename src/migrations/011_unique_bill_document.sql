-- Ensure a document can only have one bill
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'ux_bills_document'
  ) THEN
    -- Remove any accidental duplicates by keeping the latest bill_id per document_id
    WITH ranked AS (
      SELECT bill_id,
             document_id,
             ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY bill_id DESC) AS rn
      FROM bills
      WHERE document_id IS NOT NULL
    )
    DELETE FROM bills
    WHERE bill_id IN (SELECT bill_id FROM ranked WHERE rn > 1);

    CREATE UNIQUE INDEX ux_bills_document ON bills(document_id)
      WHERE document_id IS NOT NULL;
  END IF;
END$$;
