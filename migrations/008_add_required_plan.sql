-- Add required_plan column to subjects and tryout_packages
-- Values: 'gratis' (default), 'premium', 'sultan'

DO $$ BEGIN
  ALTER TABLE subjects ADD COLUMN required_plan VARCHAR(20) DEFAULT 'gratis';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tryout_packages ADD COLUMN required_plan VARCHAR(20) DEFAULT 'gratis';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
