-- Migration 056: Add registration_number to job_applications
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100) UNIQUE;
