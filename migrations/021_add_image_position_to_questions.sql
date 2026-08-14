-- Migration to add image_position column to questions and um_questions tables
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'image_position') THEN
    ALTER TABLE questions ADD COLUMN image_position VARCHAR(20) DEFAULT 'after' CHECK (image_position IN ('before', 'after'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'um_questions' AND column_name = 'image_position') THEN
    ALTER TABLE um_questions ADD COLUMN image_position VARCHAR(20) DEFAULT 'after' CHECK (image_position IN ('before', 'after'));
  END IF;
END $$;
