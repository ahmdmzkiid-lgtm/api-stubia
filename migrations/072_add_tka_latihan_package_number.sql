-- Add package_number to TKA latihan sessions and TKA questions for package grouping
ALTER TABLE IF EXISTS tka_latihan_sessions ADD COLUMN IF NOT EXISTS package_number INT DEFAULT 1;
ALTER TABLE IF EXISTS tka_questions ADD COLUMN IF NOT EXISTS package_number INT DEFAULT 1;
