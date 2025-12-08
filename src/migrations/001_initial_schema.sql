-- Users table (for authentication)
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Uploaded documents (bills, receipts, invoices)
CREATE TABLE IF NOT EXISTS documents (
    document_id SERIAL PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    file_type VARCHAR(50),
    uploaded_by INTEGER REFERENCES users(user_id),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    document_category VARCHAR(100),
    status VARCHAR(50) DEFAULT 'uploaded',
    gemini_data JSONB,
    notes TEXT
);

-- Vendors
CREATE TABLE IF NOT EXISTS vendors (
    vendor_id SERIAL PRIMARY KEY,
    vendor_name VARCHAR(255) NOT NULL,
    vendor_code VARCHAR(50) UNIQUE,
    gstin VARCHAR(15),
    pan VARCHAR(10),
    contact_person VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    address TEXT,
    vendor_type VARCHAR(100),
    payment_terms VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chart of accounts
CREATE TABLE IF NOT EXISTS accounts (
    account_id SERIAL PRIMARY KEY,
    account_code VARCHAR(50) UNIQUE NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    parent_account_id INTEGER REFERENCES accounts(account_id),
    is_active BOOLEAN DEFAULT true,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bills (extracted from documents)
CREATE TABLE IF NOT EXISTS bills (
    bill_id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(document_id),
    vendor_id INTEGER REFERENCES vendors(vendor_id),
    bill_number VARCHAR(100),
    bill_date DATE,
    due_date DATE,
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    total_amount DECIMAL(15,2),
    category VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending',
    payment_status VARCHAR(50) DEFAULT 'unpaid',
    confidence_score DECIMAL(3,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    posted_at TIMESTAMP
);

-- Bill line items
CREATE TABLE IF NOT EXISTS bill_items (
    item_id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(bill_id) ON DELETE CASCADE,
    description TEXT,
    quantity DECIMAL(10,2),
    unit_price DECIMAL(15,2),
    amount DECIMAL(15,2),
    tax_rate DECIMAL(5,2),
    tax_amount DECIMAL(15,2),
    account_id INTEGER REFERENCES accounts(account_id),
    line_number INTEGER
);

-- Journal entries
CREATE TABLE IF NOT EXISTS journal_entries (
    journal_id SERIAL PRIMARY KEY,
    entry_date DATE NOT NULL,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    description TEXT,
    total_debit DECIMAL(15,2),
    total_credit DECIMAL(15,2),
    status VARCHAR(50) DEFAULT 'draft',
    created_by INTEGER REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    posted_at TIMESTAMP
);

-- Journal entry lines (double-entry bookkeeping)
CREATE TABLE IF NOT EXISTS journal_entry_lines (
    line_id SERIAL PRIMARY KEY,
    journal_id INTEGER REFERENCES journal_entries(journal_id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(account_id),
    debit_amount DECIMAL(15,2) DEFAULT 0,
    credit_amount DECIMAL(15,2) DEFAULT 0,
    description TEXT,
    line_number INTEGER
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(document_category);
CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(bill_date);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reference ON journal_entries(reference_type, reference_id);
