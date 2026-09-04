-- Migration 088: Alter topics and tka_topics title column to TEXT to prevent VARCHAR(255) overflow
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'topics') THEN
    ALTER TABLE topics ALTER COLUMN title TYPE TEXT;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tka_topics') THEN
    ALTER TABLE tka_topics ALTER COLUMN title TYPE TEXT;
  END IF;
END $$;
