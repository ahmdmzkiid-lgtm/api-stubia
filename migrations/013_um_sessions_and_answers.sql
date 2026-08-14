-- Migration: Add Ujian Mandiri Sessions and User Answers tables

CREATE TABLE IF NOT EXISTS um_tryout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID REFERENCES um_tryout_packages(id) ON DELETE CASCADE,
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  total_score INT,
  score_breakdown JSONB
);

CREATE TABLE IF NOT EXISTS um_user_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES um_tryout_sessions(id) ON DELETE CASCADE,
  question_id UUID REFERENCES um_questions(id) ON DELETE CASCADE,
  chosen_choice_id UUID REFERENCES um_answer_choices(id) ON DELETE SET NULL,
  is_flagged BOOLEAN DEFAULT FALSE,
  time_spent_sec INT DEFAULT 0,
  position INT
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_um_tryout_sessions_user ON um_tryout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_um_tryout_sessions_package ON um_tryout_sessions(package_id);
CREATE INDEX IF NOT EXISTS idx_um_user_answers_session ON um_user_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_um_user_answers_question ON um_user_answers(question_id);
