-- Battle matches table
CREATE TABLE IF NOT EXISTS battle_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  subject_name VARCHAR(255) NOT NULL,
  question_count INT DEFAULT 5,
  time_per_question INT DEFAULT 60, -- seconds
  status VARCHAR(20) DEFAULT 'waiting', -- waiting, active, completed
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  question_ids JSONB DEFAULT '[]'::jsonb,
  current_question_index INT DEFAULT 0,
  question_started_at TIMESTAMP
);

-- Battle participants table
CREATE TABLE IF NOT EXISTS battle_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES battle_matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  answers JSONB DEFAULT '{}'::jsonb, -- { questionId: choiceId }
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(match_id, user_id)
);

-- Battle leaderboard table (per subject)
CREATE TABLE IF NOT EXISTS battle_leaderboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  subject_name VARCHAR(255) NOT NULL,
  total_matches INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  total_points INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, subject_id)
);

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_battle_matches_subject ON battle_matches(subject_id);
CREATE INDEX IF NOT EXISTS idx_battle_matches_status ON battle_matches(status);
CREATE INDEX IF NOT EXISTS idx_battle_matches_created_by ON battle_matches(created_by);
CREATE INDEX IF NOT EXISTS idx_battle_participants_match ON battle_participants(match_id);
CREATE INDEX IF NOT EXISTS idx_battle_participants_user ON battle_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_battle_leaderboard_user_subject ON battle_leaderboard(user_id, subject_id);
