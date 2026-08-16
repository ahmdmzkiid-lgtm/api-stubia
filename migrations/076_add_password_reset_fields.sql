-- Migration 076: Add reset password token and expiry fields to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS reset_password_token VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS reset_password_expires TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_reset_password_token ON users (reset_password_token);
