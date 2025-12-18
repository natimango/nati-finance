BEGIN;

-- SKU master catalog for per-SKU economics
CREATE TABLE IF NOT EXISTS sku_master (
  sku_id SERIAL PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,
  sku_name TEXT,
  drop_id INTEGER REFERENCES drops(drop_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sku_master_drop'
  ) THEN
    CREATE INDEX idx_sku_master_drop ON sku_master(drop_id);
  END IF;
END $$;

-- Price history per SKU
CREATE TABLE IF NOT EXISTS sku_price_history (
  price_id SERIAL PRIMARY KEY,
  sku_id INTEGER REFERENCES sku_master(sku_id) ON DELETE CASCADE,
  selling_price NUMERIC(14,2) NOT NULL,
  mrp NUMERIC(14,2),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sku_price_history_sku'
  ) THEN
    CREATE INDEX idx_sku_price_history_sku ON sku_price_history(sku_id, effective_from DESC);
  END IF;
END $$;

-- Cost layers allowed per SKU
CREATE TABLE IF NOT EXISTS sku_cost_layers (
  cost_layer_id SERIAL PRIMARY KEY,
  sku_id INTEGER REFERENCES sku_master(sku_id) ON DELETE CASCADE,
  cost_type TEXT NOT NULL,
  amount_per_unit NUMERIC(14,2) NOT NULL,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_sku_cost_type CHECK (cost_type IN ('manufacturing','packaging','shipping_subsidy','gateway_fee_est','returns_allowance','inbound_freight','other_variable'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sku_cost_layers_sku'
  ) THEN
    CREATE INDEX idx_sku_cost_layers_sku ON sku_cost_layers(sku_id, effective_from DESC);
  END IF;
END $$;

-- Finance settings store small key/value overrides
CREATE TABLE IF NOT EXISTS finance_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO finance_settings(setting_key, setting_value)
SELECT 'target_net_margin_buffer', '0.2'
WHERE NOT EXISTS (
  SELECT 1 FROM finance_settings WHERE setting_key = 'target_net_margin_buffer'
);

COMMIT;
