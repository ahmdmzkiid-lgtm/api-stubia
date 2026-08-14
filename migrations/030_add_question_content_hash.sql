-- Migration: Add content_hash column to track duplicate questions and prevent/exclude duplicates
ALTER TABLE questions ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);
ALTER TABLE um_questions ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

-- Add index for content_hash lookup optimization
CREATE INDEX IF NOT EXISTS idx_questions_content_hash ON questions(content_hash);
CREATE INDEX IF NOT EXISTS idx_um_questions_content_hash ON um_questions(content_hash);
