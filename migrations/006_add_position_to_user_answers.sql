-- Add position column to user_answers to preserve question order in sessions
ALTER TABLE user_answers 
ADD COLUMN IF NOT EXISTS position INT DEFAULT 0;

-- Update existing user_answers to set position based on insertion order within each session
UPDATE user_answers 
SET position = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id ASC) as rn
  FROM user_answers
) sub
WHERE user_answers.id = sub.id;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_user_answers_session_position ON user_answers(session_id, position);
