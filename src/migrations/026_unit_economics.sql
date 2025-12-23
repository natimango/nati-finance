BEGIN;

-- Per-SKU assumptions for unit economics / max CAC calculations
CREATE TABLE IF NOT EXISTS sku_assumptions (
  sku_assumption_id SERIAL PRIMARY KEY,
  sku_id INT NOT NULL UNIQUE REFERENCES sku_master(sku_id) ON DELETE CASCADE,
  shipping_subsidy_avg NUMERIC(12,2),
  gateway_fee_pct NUMERIC(6,4),
  gateway_fee_fixed NUMERIC(12,2),
  returns_rate NUMERIC(6,4),
  return_shipping_avg NUMERIC(12,2),
  reconditioning_cost_avg NUMERIC(12,2),
  expected_resale_discount_pct NUMERIC(6,4),
  cm_buffer NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optional size-level sell-through signals to adjust CAC per size
CREATE TABLE IF NOT EXISTS size_sellthrough (
  size_sellthrough_id SERIAL PRIMARY KEY,
  sku_id INT NOT NULL REFERENCES sku_master(sku_id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  units_available INT,
  units_sold INT,
  bottleneck_flag BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sku_id, size)
);

CREATE INDEX IF NOT EXISTS idx_size_sellthrough_sku ON size_sellthrough(sku_id);

COMMIT;
