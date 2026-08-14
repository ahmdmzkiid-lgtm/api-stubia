-- Migration 070: Add required_plan and icon fields to SKD tables
ALTER TABLE IF EXISTS skd_topics ADD COLUMN IF NOT EXISTS required_plan VARCHAR(50) DEFAULT 'gratis';
ALTER TABLE IF EXISTS skd_tryout_packages ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT 'assignment';
ALTER TABLE IF EXISTS skd_subjects ADD COLUMN IF NOT EXISTS required_plan VARCHAR(50) DEFAULT 'gratis';
