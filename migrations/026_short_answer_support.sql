-- Migration: Add short answer question support (UTBK only)

-- Add question_type to questions table (UTBK)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'question_type') THEN
    ALTER TABLE questions ADD COLUMN question_type VARCHAR(20) DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'short_answer'));
  END IF;
END $$;

-- Add answer_text to user_answers table (UTBK) for storing typed short answers
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_answers' AND column_name = 'answer_text') THEN
    ALTER TABLE user_answers ADD COLUMN answer_text TEXT;
  END IF;
END $$;
