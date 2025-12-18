BEGIN;

-- ensure drop names exist before adding constraints
INSERT INTO drops (drop_name)
VALUES ('Drop 1'), ('Unassigned')
ON CONFLICT (drop_name) DO NOTHING;

-- backfill existing postable bill_items to Unassigned drop
WITH unassigned AS (
  SELECT drop_id FROM drops WHERE drop_name = 'Unassigned' LIMIT 1
)
UPDATE bill_items
SET drop_id = (SELECT drop_id FROM unassigned)
WHERE drop_id IS NULL AND is_postable = TRUE;

-- posting constraint ensures dims present when posted
ALTER TABLE bill_items
  ADD CONSTRAINT bill_items_posted_requires_dims
  CHECK (
    posting_status <> 'posted'
    OR (
      coa_account_id IS NOT NULL
      AND department_id IS NOT NULL
      AND drop_id IS NOT NULL
    )
  );

-- add indexes for gate reporting
CREATE INDEX IF NOT EXISTS idx_bill_items_posting_status ON bill_items(posting_status);
CREATE INDEX IF NOT EXISTS idx_bill_items_document_status ON bill_items(bill_id, posting_status);

COMMIT;
