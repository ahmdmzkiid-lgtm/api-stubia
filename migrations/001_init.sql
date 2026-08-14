-- Stubia UTBK Database Schema
-- Auto-executed on server startup

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('TPS', 'TKA_SAINTEK', 'TKA_SOSHUM')),
  duration_minutes INT DEFAULT 90
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID REFERENCES subjects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  source VARCHAR(100) DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS answer_choices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  label CHAR(1) NOT NULL CHECK (label IN ('A','B','C','D','E')),
  content TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS tryout_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) UNIQUE NOT NULL,
  subject_config JSONB NOT NULL,
  scheduled_at TIMESTAMP,
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tryout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  package_id UUID REFERENCES tryout_packages(id),
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  total_score FLOAT,
  score_breakdown JSONB
);

CREATE TABLE IF NOT EXISTS user_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES tryout_sessions(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id),
  chosen_choice_id UUID REFERENCES answer_choices(id),
  is_flagged BOOLEAN DEFAULT FALSE,
  time_spent_sec INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  question_id UUID REFERENCES questions(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, question_id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);
CREATE INDEX IF NOT EXISTS idx_answer_choices_question ON answer_choices(question_id);
CREATE INDEX IF NOT EXISTS idx_tryout_sessions_user ON tryout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tryout_sessions_package ON tryout_sessions(package_id);
CREATE INDEX IF NOT EXISTS idx_user_answers_session ON user_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_user_answers_question ON user_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_question ON bookmarks(question_id);

-- Site settings (key-value store for admin-configurable content)
CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Default banner settings
INSERT INTO site_settings (key, value) VALUES
  ('banner_image_url', 'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=1920&q=80'),
  ('banner_title', 'Raih Skor UTBK Terbaikmu'),
  ('banner_subtitle', 'Bergabung dengan 50.000+ pelajar yang telah mempersiapkan UTBK bersama Stubia. Latihan soal, tryout simulasi, dan pembahasan lengkap.')
ON CONFLICT (key) DO NOTHING;

-- Default schedule (JSON array)
INSERT INTO site_settings (key, value) VALUES
  ('schedule_json', '[{"day":"SEN","date":"12","title":"Tryout Penalaran Umum","time":"09:00 - 11:30","active":true},{"day":"SEL","date":"13","title":"Latihan Pengetahuan Kuantitatif","time":"14:00 - 15:30","active":false},{"day":"RAB","date":"14","title":"Review Literasi Bahasa Indonesia","time":"10:00 - 11:00","active":false}]')
ON CONFLICT (key) DO NOTHING;

