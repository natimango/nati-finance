-- Add payment_method to bills to tag cash/UPI/bank/cheque
ALTER TABLE bills ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'UNSPECIFIED';
CREATE INDEX IF NOT EXISTS idx_bills_payment_method ON bills(payment_method);
