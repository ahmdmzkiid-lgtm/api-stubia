-- Migration 055: Add work_duration to job_applications
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS work_duration VARCHAR(255);
