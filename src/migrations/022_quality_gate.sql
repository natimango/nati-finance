BEGIN;

-- Chart of Accounts reference (immutable list for classification)
CREATE TABLE IF NOT EXISTS coa_accounts (
    coa_account_id SERIAL PRIMARY KEY,
    account_code VARCHAR(20) UNIQUE NOT NULL,
    account_name VARCHAR(200) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    description TEXT
);

-- Department reference table
CREATE TABLE IF NOT EXISTS departments (
    department_id SERIAL PRIMARY KEY,
    department_name VARCHAR(100) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT
);

-- Drop list used for tagging line items
CREATE TABLE IF NOT EXISTS drops (
    drop_id SERIAL PRIMARY KEY,
    drop_name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

-- Seed master data
INSERT INTO coa_accounts (account_code, account_name, account_type)
SELECT account_code, account_name, account_type
FROM accounts
WHERE account_code IS NOT NULL
ON CONFLICT (account_code) DO NOTHING;

INSERT INTO departments (department_name)
VALUES
  ('Design'),
  ('Production'),
  ('Marketing'),
  ('Operations'),
  ('Finance'),
  ('Admin'),
  ('Tech')
ON CONFLICT (department_name) DO NOTHING;

INSERT INTO drops (drop_name)
VALUES ('Drop 1'), ('Unassigned')
ON CONFLICT (drop_name) DO NOTHING;

-- ensure Unassigned drop exists for use by defaults
INSERT INTO drops (drop_name) VALUES ('Unassigned')
ON CONFLICT (drop_name) DO NOTHING;

-- Add quality gating columns to bill_items
ALTER TABLE bill_items
  ADD COLUMN IF NOT EXISTS coa_account_id INTEGER REFERENCES coa_accounts(coa_account_id),
  ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(department_id),
  ADD COLUMN IF NOT EXISTS drop_id INTEGER REFERENCES drops(drop_id),
  ADD COLUMN IF NOT EXISTS is_postable BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS posting_status VARCHAR(20) NOT NULL DEFAULT 'unposted',
  ADD COLUMN IF NOT EXISTS posting_reason TEXT;

ALTER TABLE bill_items
  ADD CONSTRAINT chk_bill_items_posting_status
  CHECK (posting_status IN ('unposted', 'posted'));

CREATE INDEX IF NOT EXISTS idx_bill_items_drop ON bill_items(drop_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_coa ON bill_items(coa_account_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_department ON bill_items(department_id);

COMMIT;
