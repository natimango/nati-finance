-- Add missing columns to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id INTEGER REFERENCES accounts(account_id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description TEXT;

-- Product/SKU Master for D2C
CREATE TABLE IF NOT EXISTS products (
    product_id SERIAL PRIMARY KEY,
    sku_code VARCHAR(50) UNIQUE NOT NULL,
    product_name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    unit_price DECIMAL(15,2),
    cost_price DECIMAL(15,2),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inventory tracking
CREATE TABLE IF NOT EXISTS inventory_transactions (
    transaction_id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(product_id),
    transaction_type VARCHAR(50), -- IN, OUT, ADJUSTMENT
    quantity INTEGER NOT NULL,
    unit_cost DECIMAL(15,2),
    total_value DECIMAL(15,2),
    reference_type VARCHAR(50), -- PURCHASE, SALE, MANUFACTURING
    reference_id INTEGER,
    transaction_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sales/Revenue tracking
CREATE TABLE IF NOT EXISTS sales_orders (
    order_id SERIAL PRIMARY KEY,
    order_number VARCHAR(100) UNIQUE NOT NULL,
    order_date DATE NOT NULL,
    customer_name VARCHAR(200),
    customer_email VARCHAR(200),
    customer_phone VARCHAR(50),
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    shipping_amount DECIMAL(15,2),
    total_amount DECIMAL(15,2),
    payment_status VARCHAR(50) DEFAULT 'PENDING',
    fulfillment_status VARCHAR(50) DEFAULT 'PENDING',
    channel VARCHAR(100), -- WEBSITE, INSTAGRAM, WHATSAPP, MARKETPLACE
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_order_items (
    item_id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES sales_orders(order_id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(product_id),
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL,
    discount DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) NOT NULL,
    line_number INTEGER
);

-- Monthly summaries for quick reporting
CREATE TABLE IF NOT EXISTS monthly_summary (
    summary_id SERIAL PRIMARY KEY,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    revenue DECIMAL(15,2) DEFAULT 0,
    cogs DECIMAL(15,2) DEFAULT 0,
    gross_profit DECIMAL(15,2) DEFAULT 0,
    expenses DECIMAL(15,2) DEFAULT 0,
    net_profit DECIMAL(15,2) DEFAULT 0,
    bills_count INTEGER DEFAULT 0,
    orders_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(year, month)
);

-- Budget tracking
CREATE TABLE IF NOT EXISTS budgets (
    budget_id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(account_id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    budgeted_amount DECIMAL(15,2) NOT NULL,
    actual_amount DECIMAL(15,2) DEFAULT 0,
    variance DECIMAL(15,2) DEFAULT 0,
    notes TEXT,
    UNIQUE(account_id, year, month)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku_code);
CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_date ON inventory_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_sales_orders_date ON sales_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON sales_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_monthly_summary_period ON monthly_summary(year, month);

-- Insert default Chart of Accounts for D2C
INSERT INTO accounts (account_code, account_name, account_type, is_active) VALUES
-- ASSETS
('1000', 'Assets', 'ASSET', true),
('1100', 'Current Assets', 'ASSET', true),
('1110', 'Cash in Hand', 'ASSET', true),
('1120', 'Bank Accounts', 'ASSET', true),
('1130', 'Accounts Receivable', 'ASSET', true),
('1140', 'Inventory', 'ASSET', true),
('1150', 'Prepaid Expenses', 'ASSET', true),
('1300', 'Input Tax Credit (GST)', 'ASSET', true),

-- LIABILITIES
('2000', 'Liabilities', 'LIABILITY', true),
('2100', 'Accounts Payable', 'LIABILITY', true),
('2200', 'Output Tax Payable (GST)', 'LIABILITY', true),
('2300', 'Salary Payable', 'LIABILITY', true),
('2400', 'Loans Payable', 'LIABILITY', true),

-- EQUITY
('3000', 'Owner''s Equity', 'EQUITY', true),
('3100', 'Capital', 'EQUITY', true),
('3200', 'Retained Earnings', 'EQUITY', true),
('3300', 'Current Year Profit/Loss', 'EQUITY', true),

-- REVENUE
('4000', 'Revenue', 'REVENUE', true),
('4010', 'Product Sales', 'REVENUE', true),
('4020', 'Service Revenue', 'REVENUE', true),

-- COST OF GOODS SOLD (COGS)
('4100', 'Cost of Goods Sold', 'COGS', true),
('4110', 'Raw Materials', 'COGS', true),
('4120', 'Manufacturing Costs', 'COGS', true),
('4130', 'Stitching Costs', 'COGS', true),
('4140', 'Packaging Materials', 'COGS', true),
('4150', 'Shipping & Logistics', 'COGS', true),

-- OPERATING EXPENSES
('5000', 'Operating Expenses', 'EXPENSE', true),
('5100', 'Food & Meals', 'EXPENSE', true),
('5200', 'Travel & Transportation', 'EXPENSE', true),
('5300', 'Vendor Payments', 'EXPENSE', true),
('5400', 'Salaries & Wages', 'EXPENSE', true),
('5500', 'Rent Expense', 'EXPENSE', true),
('5600', 'Technology Expense', 'EXPENSE', true),
('5700', 'Marketing & Advertising', 'EXPENSE', true),
('5800', 'Utilities', 'EXPENSE', true),
('5900', 'Miscellaneous Expense', 'EXPENSE', true)
ON CONFLICT (account_code) DO NOTHING;

-- Add unique constraint to vendor_code if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vendors_vendor_code_key'
    ) THEN
        ALTER TABLE vendors ADD CONSTRAINT vendors_vendor_code_key UNIQUE (vendor_code);
    END IF;
END $$;
