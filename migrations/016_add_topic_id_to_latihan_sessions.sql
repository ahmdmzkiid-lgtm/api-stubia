-- Add topic_id to latihan_sessions table for topic-based progress tracking
ALTER TABLE latihan_sessions ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES topics(id) ON DELETE SET NULL;

-- Create index for faster topic-based session queries
CREATE INDEX IF NOT EXISTS idx_latihan_sessions_topic ON latihan_sessions(topic_id);
