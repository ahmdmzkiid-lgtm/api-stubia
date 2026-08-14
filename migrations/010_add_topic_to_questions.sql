-- Add topic_id to questions table for latihan topic management
ALTER TABLE questions ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES topics(id) ON DELETE SET NULL;

-- Create index for faster topic-based queries
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);
