-- Migration to add stimulus column to um_questions table
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'um_questions' AND column_name = 'stimulus') THEN
    ALTER TABLE um_questions ADD COLUMN stimulus TEXT;
  END IF;
END $$;
