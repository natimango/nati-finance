-- Track every change to drop budgets
CREATE TABLE IF NOT EXISTS drop_budget_history (
    history_id SERIAL PRIMARY KEY,
    drop_name TEXT NOT NULL,
    department TEXT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    changed_by TEXT,
    change_type TEXT DEFAULT 'UPSERT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure drop budgets are unique per drop + department
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'ux_drop_budgets_drop_dept'
    ) THEN
        CREATE UNIQUE INDEX ux_drop_budgets_drop_dept
            ON drop_budgets(drop_name, department);
    END IF;
END $$;

-- CFO alerts table
CREATE TABLE IF NOT EXISTS alerts (
    alert_id SERIAL PRIMARY KEY,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    drop_name TEXT,
    category_group TEXT,
    document_id INTEGER,
    bill_id INTEGER,
    metadata JSONB,
    resolved_at TIMESTAMP,
    resolved_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(alert_type, resolved_at);
