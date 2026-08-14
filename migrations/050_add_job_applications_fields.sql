-- Migration 050: Add extra fields to job_applications table

ALTER TABLE job_applications
ADD COLUMN IF NOT EXISTS start_date VARCHAR(255),
ADD COLUMN IF NOT EXISTS ready_for_training BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS portfolio_url TEXT,
ADD COLUMN IF NOT EXISTS last_education VARCHAR(255);
