-- Migration: Support complex_mc_multi (Pilihan Lebih dari 1) and dynamic true/false options_config
DO $$
BEGIN
  -- 1. Update tka_questions table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tka_questions') THEN
    -- Alter question_type column to VARCHAR(50) if needed
    ALTER TABLE tka_questions ALTER COLUMN question_type TYPE VARCHAR(50);
    
    -- Drop old check constraint and add updated one
    ALTER TABLE tka_questions DROP CONSTRAINT IF EXISTS tka_questions_question_type_check;
    ALTER TABLE tka_questions ADD CONSTRAINT tka_questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'short_answer', 'complex_mc_tf', 'complex_mc_multi'));

    -- Add options_config JSONB column if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tka_questions' AND column_name = 'options_config') THEN
      ALTER TABLE tka_questions ADD COLUMN options_config JSONB DEFAULT '{}';
    END IF;
  END IF;

  -- 2. Update questions table (UTBK/SNBT)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'questions') THEN
    -- Alter question_type column to VARCHAR(50) if needed
    ALTER TABLE questions ALTER COLUMN question_type TYPE VARCHAR(50);
    
    -- Drop old check constraint and add updated one
    ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_question_type_check;
    ALTER TABLE questions ADD CONSTRAINT questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'short_answer', 'complex_mc_tf', 'complex_mc_multi'));

    -- Add options_config JSONB column if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'options_config') THEN
      ALTER TABLE questions ADD COLUMN options_config JSONB DEFAULT '{}';
    END IF;
  END IF;
END $$;
