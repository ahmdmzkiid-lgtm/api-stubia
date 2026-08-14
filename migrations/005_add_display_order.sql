-- Add display_order column to questions table for consistent ordering
ALTER TABLE questions 
ADD COLUMN IF NOT EXISTS display_order INT;

-- Backfill display_order based on created_at ordering
UPDATE questions 
SET display_order = (
  SELECT ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY created_at ASC, id ASC)
  FROM questions q2 
  WHERE q2.id = questions.id
);

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_questions_display_order ON questions(subject_id, display_order);
