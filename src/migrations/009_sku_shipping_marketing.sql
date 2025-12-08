-- Add SKU code to bill items
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS sku_code VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_bill_items_sku ON bill_items(sku_code);

-- Shipping/fulfillment costs
CREATE TABLE IF NOT EXISTS shipments (
    shipment_id SERIAL PRIMARY KEY,
    order_id VARCHAR(100),
    carrier VARCHAR(100),
    tracking_number VARCHAR(150),
    charge_amount DECIMAL(15,2),
    currency VARCHAR(10) DEFAULT 'INR',
    drop_name VARCHAR(150),
    sku_code VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shipments_drop ON shipments(drop_name);
CREATE INDEX IF NOT EXISTS idx_shipments_carrier ON shipments(carrier);

-- Marketing spend ingestion
CREATE TABLE IF NOT EXISTS marketing_spend (
    spend_id SERIAL PRIMARY KEY,
    channel VARCHAR(100),
    campaign VARCHAR(150),
    drop_name VARCHAR(150),
    amount DECIMAL(15,2),
    currency VARCHAR(10) DEFAULT 'INR',
    spend_date DATE DEFAULT CURRENT_DATE,
    source VARCHAR(50), -- META/GOOGLE/OTHER
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_marketing_drop ON marketing_spend(drop_name);
CREATE INDEX IF NOT EXISTS idx_marketing_channel ON marketing_spend(channel);
