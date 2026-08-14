-- ============================================================
-- SKD CPNS: Tabel Lengkap (Seleksi Kompetensi Dasar - CPNS)
-- SKD terdiri dari 3 subtes: TWK, TIU, TKP
-- ============================================================

-- 1. Subtes SKD (TWK, TIU, TKP)
CREATE TABLE IF NOT EXISTS skd_subjects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  description TEXT,
  question_count INT DEFAULT 35,
  duration_minutes INT DEFAULT 35,
  icon VARCHAR(100) DEFAULT 'school',
  icon_color VARCHAR(20) DEFAULT '#0050cb',
  bg_color VARCHAR(20) DEFAULT '#dae1ff',
  points_correct INT DEFAULT 5,
  points_incorrect INT DEFAULT 0,
  passing_grade INT DEFAULT 65,
  is_tkp BOOLEAN DEFAULT FALSE,
  display_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Topik per subtes SKD
CREATE TABLE IF NOT EXISTS skd_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID NOT NULL REFERENCES skd_subjects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100) DEFAULT 'topic',
  questions_count VARCHAR(50),
  difficulty_level VARCHAR(50) DEFAULT 'Dasar',
  is_popular BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Paket tryout SKD (dibuat SEBELUM questions untuk FK)
CREATE TABLE IF NOT EXISTS skd_tryout_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  subject_config JSONB NOT NULL DEFAULT '[]',
  scheduled_at TIMESTAMP,
  is_public BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  required_plan VARCHAR(50) DEFAULT 'gratis',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Bank soal SKD
CREATE TABLE IF NOT EXISTS skd_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID NOT NULL REFERENCES skd_subjects(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES skd_topics(id) ON DELETE SET NULL,
  tryout_package_id UUID REFERENCES skd_tryout_packages(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  stimulus TEXT,
  image_url TEXT,
  image_position VARCHAR(20) DEFAULT 'after' CHECK (image_position IN ('before', 'after')),
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_type VARCHAR(20) DEFAULT 'multiple_choice',
  source VARCHAR(100) DEFAULT 'manual',
  display_order INT,
  content_hash VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Pilihan jawaban soal SKD
-- Untuk TKP: setiap pilihan punya nilai sendiri (1-5)
-- Untuk TWK & TIU: hanya is_correct yang dipakai
CREATE TABLE IF NOT EXISTS skd_answer_choices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID NOT NULL REFERENCES skd_questions(id) ON DELETE CASCADE,
  label CHAR(1) NOT NULL CHECK (label IN ('A','B','C','D','E')),
  content TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  tkp_point INT DEFAULT 0,
  explanation TEXT
);

-- 6. Sesi tryout SKD per user
CREATE TABLE IF NOT EXISTS skd_tryout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES skd_tryout_packages(id) ON DELETE CASCADE,
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  total_score FLOAT,
  twk_score INT DEFAULT 0,
  tiu_score INT DEFAULT 0,
  tkp_score INT DEFAULT 0,
  score_breakdown JSONB,
  is_passed BOOLEAN,
  current_subject_index INT DEFAULT 0
);

-- 7. Jawaban user dalam sesi tryout SKD
CREATE TABLE IF NOT EXISTS skd_user_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES skd_tryout_sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES skd_questions(id) ON DELETE CASCADE,
  chosen_choice_id UUID REFERENCES skd_answer_choices(id) ON DELETE SET NULL,
  is_flagged BOOLEAN DEFAULT FALSE,
  time_spent_sec INT DEFAULT 0,
  position INT DEFAULT 0,
  points_earned INT DEFAULT 0,
  UNIQUE(session_id, question_id)
);

-- 8. Sesi latihan soal SKD
CREATE TABLE IF NOT EXISTS skd_latihan_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES skd_subjects(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES skd_topics(id) ON DELETE SET NULL,
  subject_name VARCHAR(255),
  total_questions INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  incorrect_count INT DEFAULT 0,
  unanswered_count INT DEFAULT 0,
  total_score INT DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP DEFAULT NOW()
);

-- 9. Jawaban latihan soal SKD
CREATE TABLE IF NOT EXISTS skd_latihan_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES skd_latihan_sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES skd_questions(id) ON DELETE CASCADE,
  chosen_choice_id UUID REFERENCES skd_answer_choices(id) ON DELETE SET NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  points_earned INT DEFAULT 0,
  time_spent_sec INT DEFAULT 0,
  position INT DEFAULT 0
);

-- 10. Extend tryout_registrations untuk support 'cpns' package_type
ALTER TABLE tryout_registrations
  ADD COLUMN IF NOT EXISTS cpns_package_id UUID REFERENCES skd_tryout_packages(id) ON DELETE SET NULL;

-- Drop old constraints and recreate
ALTER TABLE tryout_registrations
  DROP CONSTRAINT IF EXISTS tryout_registrations_package_type_check;

ALTER TABLE tryout_registrations
  DROP CONSTRAINT IF EXISTS tryout_registrations_check;

ALTER TABLE tryout_registrations
  DROP CONSTRAINT IF EXISTS tryout_registrations_package_check;

-- Add new check constraints
ALTER TABLE tryout_registrations
  ADD CONSTRAINT tryout_registrations_package_type_check
  CHECK (package_type IN ('utbk', 'um', 'cpns'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_skd_questions_subject ON skd_questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_skd_questions_topic ON skd_questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_skd_questions_package ON skd_questions(tryout_package_id);
CREATE INDEX IF NOT EXISTS idx_skd_topics_subject ON skd_topics(subject_id);
CREATE INDEX IF NOT EXISTS idx_skd_sessions_user ON skd_tryout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_skd_sessions_package ON skd_tryout_sessions(package_id);
CREATE INDEX IF NOT EXISTS idx_skd_answers_session ON skd_user_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_skd_latihan_sessions_user ON skd_latihan_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_skd_latihan_answers_session ON skd_latihan_answers(session_id);

-- Seed 3 subtes SKD
INSERT INTO skd_subjects (name, full_name, description, question_count, duration_minutes, icon, icon_color, bg_color, points_correct, points_incorrect, passing_grade, is_tkp, display_order)
VALUES
  ('TWK', 'Tes Wawasan Kebangsaan', 'Mengukur pengetahuan dan implementasi nilai-nilai kebangsaan: Pancasila, UUD 1945, NKRI, Bhineka Tunggal Ika, dan Bahasa Indonesia.', 35, 35, 'flag', '#c62828', '#ffebee', 5, 0, 65, FALSE, 1),
  ('TIU', 'Tes Intelejensia Umum', 'Mengukur kemampuan verbal (analogi, silogisme, analitik), numerik (berhitung, deret angka, matematika), dan figural (analogi, ketidaksamaan, serial).', 35, 35, 'psychology', '#1565c0', '#e3f2fd', 5, 0, 80, FALSE, 2),
  ('TKP', 'Tes Karakteristik Pribadi', 'Mengukur kompetensi terkait orientasi pada pelayanan, orang lain, kejujuran, integritas, kemampuan beradaptasi, pengendalian diri, dan semangat berprestasi.', 45, 10, 'person', '#2e7d32', '#e8f5e9', 0, 0, 166, TRUE, 3)
ON CONFLICT (name) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  description = EXCLUDED.description,
  question_count = EXCLUDED.question_count,
  duration_minutes = EXCLUDED.duration_minutes,
  icon = EXCLUDED.icon,
  icon_color = EXCLUDED.icon_color,
  bg_color = EXCLUDED.bg_color,
  passing_grade = EXCLUDED.passing_grade,
  is_tkp = EXCLUDED.is_tkp,
  display_order = EXCLUDED.display_order;
