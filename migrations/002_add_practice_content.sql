-- Update subjects table to match premium practice hub requirements
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS icon VARCHAR(100);
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS bg_color VARCHAR(20);
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS icon_color VARCHAR(20);

-- Ensure title is populated with name if null
UPDATE subjects SET title = name WHERE title IS NULL;

-- Create topics table
CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID REFERENCES subjects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  questions_count VARCHAR(50),
  difficulty_level VARCHAR(50) DEFAULT 'Dasar',
  card_type VARCHAR(50) DEFAULT 'standard',
  is_popular BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for topic lookups
CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id);
