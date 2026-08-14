-- Migration to add stimulus and update image_position constraint in questions table
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'stimulus') THEN
    ALTER TABLE questions ADD COLUMN stimulus TEXT;
  END IF;
END $$;

-- Safely drop old check constraint on image_position if it exists, and add new one
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'questions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%image_position%';
  
  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE questions DROP CONSTRAINT ' || constraint_name;
  END IF;
END $$;

ALTER TABLE questions ADD CONSTRAINT questions_image_position_check CHECK (image_position IN ('before', 'after', 'top', 'middle', 'bottom', 'atas', 'ditengah', 'bawah'));
