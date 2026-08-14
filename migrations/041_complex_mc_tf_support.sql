-- Migration: Support complex multiple-choice true/false questions
DO $$
BEGIN
  -- Drop existing check constraint if it exists
  ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_question_type_check;
  
  -- Re-add check constraint with complex_mc_tf support
  ALTER TABLE questions ADD CONSTRAINT questions_question_type_check 
    CHECK (question_type IN ('multiple_choice', 'short_answer', 'complex_mc_tf'));
END $$;
