-- Add target_ptn and target_major to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS target_ptn VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS target_major VARCHAR(255) DEFAULT NULL;
