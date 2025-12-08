-- Payment terms extracted by AI parser
CREATE TABLE IF NOT EXISTS payment_terms (
    term_id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(bill_id) ON DELETE CASCADE,
    payment_type VARCHAR(50), -- FULL, ADVANCE, INSTALLMENT, NET_30, NET_45, etc.
    total_amount DECIMAL(15,2),
    advance_percentage DECIMAL(5,2),
    installment_count INTEGER,
    terms_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment schedule (auto-generated from terms)
CREATE TABLE IF NOT EXISTS payment_schedule (
    schedule_id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(bill_id) ON DELETE CASCADE,
    installment_number INTEGER,
    due_date DATE NOT NULL,
    amount_due DECIMAL(15,2) NOT NULL,
    amount_paid DECIMAL(15,2) DEFAULT 0,
    payment_status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, PAID, PARTIAL, OVERDUE
    reminder_sent BOOLEAN DEFAULT false,
    last_reminder_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment transactions
CREATE TABLE IF NOT EXISTS payments (
    payment_id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(bill_id) ON DELETE CASCADE,
    schedule_id INTEGER REFERENCES payment_schedule(schedule_id),
    payment_date DATE NOT NULL,
    amount_paid DECIMAL(15,2) NOT NULL,
    payment_method VARCHAR(50), -- CASH, UPI, BANK_TRANSFER, CHEQUE, etc.
    reference_number VARCHAR(100),
    notes TEXT,
    recorded_by INTEGER REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Vendor payment history summary
CREATE TABLE IF NOT EXISTS vendor_payment_summary (
    summary_id SERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(vendor_id),
    total_billed DECIMAL(15,2) DEFAULT 0,
    total_paid DECIMAL(15,2) DEFAULT 0,
    outstanding_balance DECIMAL(15,2) DEFAULT 0,
    last_payment_date DATE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_payment_schedule_due_date ON payment_schedule(due_date);
CREATE INDEX IF NOT EXISTS idx_payment_schedule_status ON payment_schedule(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
