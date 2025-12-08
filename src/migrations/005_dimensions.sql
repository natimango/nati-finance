-- Add dimensional tags to bills for richer analytics (drop/trip/channel/campaign)
ALTER TABLE bills ADD COLUMN IF NOT EXISTS drop_name VARCHAR(150);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS trip_name VARCHAR(150);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS channel VARCHAR(100);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS campaign VARCHAR(150);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS department VARCHAR(100);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS tags JSONB;

-- Helpful indexes for grouping/filtering
CREATE INDEX IF NOT EXISTS idx_bills_drop_name ON bills(drop_name);
CREATE INDEX IF NOT EXISTS idx_bills_trip_name ON bills(trip_name);
CREATE INDEX IF NOT EXISTS idx_bills_channel ON bills(channel);
CREATE INDEX IF NOT EXISTS idx_bills_campaign ON bills(campaign);
