ALTER TABLE users
    ALTER COLUMN role SET DEFAULT 'uploader';

UPDATE users
SET role = COALESCE(NULLIF(LOWER(role), ''), 'uploader');

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check,
    ADD CONSTRAINT users_role_check CHECK (role IN ('uploader', 'manager', 'admin'));

ALTER TABLE documents
    ALTER COLUMN uploaded_by DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users ((LOWER(email)));
