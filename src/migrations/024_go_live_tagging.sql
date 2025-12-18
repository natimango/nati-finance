BEGIN;

-- Add go-live tagging columns to bill_items
ALTER TABLE bill_items
  ADD COLUMN IF NOT EXISTS go_live_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cost_nature TEXT,
  ADD COLUMN IF NOT EXISTS cost_stage TEXT;

ALTER TABLE bill_items
  ADD CONSTRAINT chk_bill_items_cost_nature
  CHECK (cost_nature IS NULL OR cost_nature IN ('setup', 'recurring'));

ALTER TABLE bill_items
  ADD CONSTRAINT chk_bill_items_cost_stage
  CHECK (cost_stage IS NULL OR cost_stage IN (
    'product_build',
    'content_production',
    'systems_tools',
    'legal_compliance',
    'ops_setup',
    'prelaunch_marketing',
    'other'
  ));

CREATE INDEX IF NOT EXISTS idx_bill_items_drop_go_live ON bill_items(drop_id, go_live_eligible);
CREATE INDEX IF NOT EXISTS idx_bill_items_go_live_nature ON bill_items(go_live_eligible, cost_nature);
CREATE INDEX IF NOT EXISTS idx_bill_items_cost_stage ON bill_items(cost_stage);

COMMIT;
