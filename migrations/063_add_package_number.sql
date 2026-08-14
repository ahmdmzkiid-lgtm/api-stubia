-- Add package_number column to tryout packages tables
ALTER TABLE IF EXISTS tryout_packages ADD COLUMN IF NOT EXISTS package_number VARCHAR(50);
ALTER TABLE IF EXISTS um_tryout_packages ADD COLUMN IF NOT EXISTS package_number VARCHAR(50);
ALTER TABLE IF EXISTS skd_tryout_packages ADD COLUMN IF NOT EXISTS package_number VARCHAR(50);
