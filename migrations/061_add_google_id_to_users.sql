-- Migration 061: Add google_id column and make password_hash nullable for Google OAuth accounts
-- Users who register via Google do not have a password, so password_hash must be nullable.
-- Without this, INSERT into users without password_hash throws a NOT NULL constraint error.

-- Make password_hash optional (nullable) for Google OAuth users
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Add google_id column to track which users registered via Google
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);

-- Index for fast lookup by google_id
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id) WHERE google_id IS NOT NULL;

-- For existing Google-registered users (who currently have a random password_hash
-- but no google_id), we cannot retroactively know their Google ID without them
-- logging in again via Google. The route handler will update google_id on next
-- Google login automatically.
