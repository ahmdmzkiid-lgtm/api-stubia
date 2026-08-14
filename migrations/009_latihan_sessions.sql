-- Latihan (practice) sessions table to persist results with IRT scoring
CREATE TABLE IF NOT EXISTS latihan_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE CASCADE,
  subject_name VARCHAR(255),
  total_questions INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  incorrect_count INT DEFAULT 0,
  unanswered_count INT DEFAULT 0,
  irt_score FLOAT DEFAULT 200,
  theta FLOAT DEFAULT -4,
  percentile INT DEFAULT 1,
  score_breakdown JSONB,
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_latihan_sessions_user ON latihan_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_latihan_sessions_subject ON latihan_sessions(subject_id);
CREATE INDEX IF NOT EXISTS idx_latihan_sessions_submitted ON latihan_sessions(submitted_at);
