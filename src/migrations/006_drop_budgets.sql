-- Drop-level budgets for D2C drops/collections with department split (COGS, Marketing, Ops, etc.)
CREATE TABLE IF NOT EXISTS drop_budgets (
    drop_budget_id SERIAL PRIMARY KEY,
    drop_name VARCHAR(150) NOT NULL,
    department VARCHAR(100) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(drop_name, department)
);

CREATE INDEX IF NOT EXISTS idx_drop_budgets_drop_dept ON drop_budgets(drop_name, department);
CREATE INDEX IF NOT EXISTS idx_drop_budgets_period ON drop_budgets(start_date, end_date);
