-- ============================================================
-- TKA (Tes Kemampuan Akademik): Tabel Lengkap & Seeding Mapel
-- Untuk Jenjang SD, SMP, dan SMA
-- ============================================================

-- 1. Subtes / Mata Pelajaran TKA (per jenjang & kategori)
CREATE TABLE IF NOT EXISTS tka_subjects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  education_level VARCHAR(10) NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA')),
  group_category VARCHAR(50) NOT NULL CHECK (group_category IN ('wajib', 'bahasa_mat_lanjut', 'ipa', 'ips', 'bahasa_asing')),
  description TEXT,
  question_count INT DEFAULT 15,
  duration_minutes INT DEFAULT 30,
  icon VARCHAR(100) DEFAULT 'school',
  icon_color VARCHAR(20) DEFAULT '#0050cb',
  bg_color VARCHAR(20) DEFAULT '#dae1ff',
  display_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT tka_subjects_level_name_unique UNIQUE (education_level, name)
);

-- 2. Topik / Materi per Subtes TKA (untuk Analisis Kelemahan Materi)
CREATE TABLE IF NOT EXISTS tka_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID NOT NULL REFERENCES tka_subjects(id) ON DELETE CASCADE,
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

-- 3. Paket Tryout TKA per Jenjang
CREATE TABLE IF NOT EXISTS tka_tryout_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  education_level VARCHAR(10) NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA')),
  description TEXT,
  subject_config JSONB NOT NULL DEFAULT '[]',
  scheduled_at TIMESTAMP,
  is_public BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  required_plan VARCHAR(50) DEFAULT 'gratis',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Bank Soal TKA
CREATE TABLE IF NOT EXISTS tka_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_id UUID NOT NULL REFERENCES tka_subjects(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES tka_topics(id) ON DELETE SET NULL,
  tryout_package_id UUID REFERENCES tka_tryout_packages(id) ON DELETE SET NULL,
  education_level VARCHAR(10) NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA')),
  content TEXT NOT NULL,
  stimulus TEXT,
  image_url TEXT,
  image_position VARCHAR(20) DEFAULT 'after' CHECK (image_position IN ('before', 'after', 'top', 'bottom', 'middle')),
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_type VARCHAR(20) DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'short_answer', 'complex_mc_tf')),
  source VARCHAR(100) DEFAULT 'manual',
  display_order INT,
  content_hash VARCHAR(64),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  workflow_status VARCHAR(50) DEFAULT 'published',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Pilihan Jawaban Soal TKA
CREATE TABLE IF NOT EXISTS tka_answer_choices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID NOT NULL REFERENCES tka_questions(id) ON DELETE CASCADE,
  label CHAR(1) NOT NULL CHECK (label IN ('A','B','C','D','E')),
  content TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  explanation TEXT
);

-- 6. Sesi Tryout TKA per User
CREATE TABLE IF NOT EXISTS tka_tryout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES tka_tryout_packages(id) ON DELETE CASCADE,
  education_level VARCHAR(10) NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA')),
  selected_elective_subjects JSONB DEFAULT '[]',
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,
  total_score FLOAT DEFAULT 0,
  score_breakdown JSONB DEFAULT '{}',
  materi_analysis JSONB DEFAULT '{}'
);

-- 7. Jawaban User dalam Sesi Tryout TKA
CREATE TABLE IF NOT EXISTS tka_user_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES tka_tryout_sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES tka_questions(id) ON DELETE CASCADE,
  chosen_choice_id UUID REFERENCES tka_answer_choices(id) ON DELETE SET NULL,
  answer_text TEXT,
  is_flagged BOOLEAN DEFAULT FALSE,
  time_spent_sec INT DEFAULT 0,
  position INT DEFAULT 0,
  points_earned FLOAT DEFAULT 0,
  UNIQUE(session_id, question_id)
);

-- 8. Sesi Latihan Soal TKA
CREATE TABLE IF NOT EXISTS tka_latihan_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  education_level VARCHAR(10) NOT NULL CHECK (education_level IN ('SD', 'SMP', 'SMA')),
  subject_id UUID REFERENCES tka_subjects(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES tka_topics(id) ON DELETE SET NULL,
  subject_name VARCHAR(255),
  total_questions INT DEFAULT 0,
  correct_count INT DEFAULT 0,
  incorrect_count INT DEFAULT 0,
  unanswered_count INT DEFAULT 0,
  total_score FLOAT DEFAULT 0,
  materi_analysis JSONB DEFAULT '{}',
  started_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP DEFAULT NOW()
);

-- 9. Detail Jawaban Latihan Soal TKA
CREATE TABLE IF NOT EXISTS tka_latihan_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES tka_latihan_sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES tka_questions(id) ON DELETE CASCADE,
  chosen_choice_id UUID REFERENCES tka_answer_choices(id) ON DELETE SET NULL,
  answer_text TEXT,
  is_correct BOOLEAN DEFAULT FALSE,
  time_spent_sec INT DEFAULT 0,
  position INT DEFAULT 0
);

-- Indexes untuk optimasi performa query
CREATE INDEX IF NOT EXISTS idx_tka_subjects_level ON tka_subjects(education_level);
CREATE INDEX IF NOT EXISTS idx_tka_questions_subject ON tka_questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_tka_questions_topic ON tka_questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_tka_questions_package ON tka_questions(tryout_package_id);
CREATE INDEX IF NOT EXISTS idx_tka_questions_level ON tka_questions(education_level);
CREATE INDEX IF NOT EXISTS idx_tka_topics_subject ON tka_topics(subject_id);
CREATE INDEX IF NOT EXISTS idx_tka_tryout_sessions_user ON tka_tryout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tka_tryout_sessions_package ON tka_tryout_sessions(package_id);
CREATE INDEX IF NOT EXISTS idx_tka_user_answers_session ON tka_user_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_tka_latihan_sessions_user ON tka_latihan_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tka_latihan_answers_session ON tka_latihan_answers(session_id);

-- Extend target_type constraint on plans table to include 'tka'
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_target_type_check;
ALTER TABLE plans ADD CONSTRAINT plans_target_type_check CHECK (target_type IN ('utbk', 'um', 'cpns', 'tka'));

-- Seeding Plan TKA Premium jika belum ada
INSERT INTO plans (name, display_name, description, price, duration_days, features, plan_type, target_type, is_active)
VALUES
  ('tka_premium', 'TKA Premium', 'Akses penuh ke seluruh Latihan & Tryout TKA (SD, SMP, SMA) tanpa batas.', 75000, 30, '["Akses semua latihan TKA", "Akses semua tryout TKA", "Analisis kelemahan per materi", "Pembahasan lengkap"]'::jsonb, 'subscription', 'tka', TRUE)
ON CONFLICT (name) DO NOTHING;

-- Seeding Mapel TKA SD (2 Wajib)
INSERT INTO tka_subjects (education_level, name, full_name, group_category, description, question_count, duration_minutes, icon, icon_color, bg_color, display_order)
VALUES
  ('SD', 'Bahasa Indonesia', 'Bahasa Indonesia SD', 'wajib', 'Mengukur kemampuan membaca, memahami teks, tata bahasa, dan literasi dasar.', 30, 75, 'menu_book', '#0284c7', '#e0f2fe', 1),
  ('SD', 'Matematika', 'Matematika SD', 'wajib', 'Mengukur logika angka, operasi hitung dasar, dan pemecahan masalah sederhana.', 30, 75, 'calculate', '#0050cb', '#dae1ff', 2)
ON CONFLICT (education_level, name) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  group_category = EXCLUDED.group_category,
  description = EXCLUDED.description,
  question_count = EXCLUDED.question_count,
  duration_minutes = EXCLUDED.duration_minutes,
  icon = EXCLUDED.icon,
  icon_color = EXCLUDED.icon_color,
  bg_color = EXCLUDED.bg_color,
  display_order = EXCLUDED.display_order;

-- Seeding Mapel TKA SMP (2 Wajib)
INSERT INTO tka_subjects (education_level, name, full_name, group_category, description, question_count, duration_minutes, icon, icon_color, bg_color, display_order)
VALUES
  ('SMP', 'Bahasa Indonesia', 'Bahasa Indonesia SMP', 'wajib', 'Mengukur kemampuan pemahaman wacana, struktur teks, dan analisis literasi.', 30, 75, 'menu_book', '#0284c7', '#e0f2fe', 1),
  ('SMP', 'Matematika', 'Matematika SMP', 'wajib', 'Mengukur kemampuan aljabar dasar, geometri, aritmatika sosial, dan logika matematika.', 30, 75, 'calculate', '#0050cb', '#dae1ff', 2)
ON CONFLICT (education_level, name) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  group_category = EXCLUDED.group_category,
  description = EXCLUDED.description,
  question_count = EXCLUDED.question_count,
  duration_minutes = EXCLUDED.duration_minutes,
  icon = EXCLUDED.icon,
  icon_color = EXCLUDED.icon_color,
  bg_color = EXCLUDED.bg_color,
  display_order = EXCLUDED.display_order;

-- Seeding Mapel TKA SMA (3 Wajib + Rumpun Pilihan)
INSERT INTO tka_subjects (education_level, name, full_name, group_category, description, question_count, duration_minutes, icon, icon_color, bg_color, display_order)
VALUES
  -- Wajib
  ('SMA', 'Bahasa Indonesia', 'Bahasa Indonesia SMA', 'wajib', 'Mengukur penalaran dan pemahaman bacaan teks kompleks.', 30, 75, 'menu_book', '#0284c7', '#e0f2fe', 1),
  ('SMA', 'Matematika', 'Matematika SMA', 'wajib', 'Mengukur pemahaman konsep matematika umum dan problem solving.', 25, 75, 'calculate', '#0050cb', '#dae1ff', 2),
  ('SMA', 'Bahasa Inggris', 'Bahasa Inggris SMA', 'wajib', 'Mengukur kemampuan pemahaman teks, gramatika, dan kosa kata Bahasa Inggris.', 30, 75, 'translate', '#d97706', '#fef3c7', 3),

  -- Kelompok Bahasa & Matematika Lanjut
  ('SMA', 'Matematika Tingkat Lanjut', 'Matematika Lanjut SMA', 'bahasa_mat_lanjut', 'Konsep matematika tingkat lanjut, kalkulus, trigonometri analitis, dan matriks.', 25, 60, 'functions', '#4f46e5', '#e0e7ff', 4),
  ('SMA', 'Bahasa Indonesia Tingkat Lanjut', 'Bahasa Indonesia Lanjut SMA', 'bahasa_mat_lanjut', 'Kritik sastra, kebahasaan mendalam, dan analisis wacana akademis.', 25, 60, 'history_edu', '#2563eb', '#dbeafe', 5),
  ('SMA', 'Bahasa Inggris Tingkat Lanjut', 'Bahasa Inggris Lanjut SMA', 'bahasa_mat_lanjut', 'Advanced reading comprehension, academic writing structure, and vocabulary.', 25, 60, 'language', '#059669', '#d1fae5', 6),

  -- Kelompok IPA (Sains)
  ('SMA', 'Fisika', 'Fisika SMA', 'ipa', 'Konsep mekanika, termodinamika, gelombang, optik, dan listrik magnet.', 25, 60, 'science', '#7c3aed', '#ede9fe', 7),
  ('SMA', 'Kimia', 'Kimia SMA', 'ipa', 'Struktur atom, ikatan kimia, stoikiometri, larutan, dan kinetika reaksi.', 25, 60, 'biotech', '#dc2626', '#fee2e2', 8),
  ('SMA', 'Biologi', 'Biologi SMA', 'ipa', 'Biologi sel, genetika, ekologi, fisiologi manusia, dan evolusi.', 25, 60, 'eco', '#16a34a', '#dcfce7', 9),

  -- Kelompok IPS (Sosial & Humaniora)
  ('SMA', 'Ekonomi', 'Ekonomi SMA', 'ips', 'Prinsip akuntansi, mikro & makro ekonomi, serta pasar keuangan.', 25, 60, 'bar_chart', '#0891b2', '#cffafe', 10),
  ('SMA', 'Sosiologi', 'Sosiologi SMA', 'ips', 'Struktur sosial, konflik, integrasi, dan perubahan sosial.', 25, 60, 'groups', '#ea580c', '#ffedd5', 11),
  ('SMA', 'Geografi', 'Geografi SMA', 'ips', 'Fenomena geosfer, pemetaan, citra penginderaan jauh, dan kewilayahan.', 25, 60, 'public', '#059669', '#ecfdf5', 12),
  ('SMA', 'Sejarah', 'Sejarah SMA', 'ips', 'Sejarah Indonesia, peristiwa dunia, dan metode sejarah.', 25, 60, 'history', '#9333ea', '#f3e8ff', 13),
  ('SMA', 'Antropologi', 'Antropologi SMA', 'ips', 'Kebudayaan manusia, dinamika tradisi, dan keberagaman etnografis.', 25, 60, 'psychology', '#db2777', '#fce7f3', 14),
  ('SMA', 'PPKN / Pendidikan Pancasila', 'PPKN SMA', 'ips', 'Konstitusi UUD 1945, hak asasi manusia, dan nilai-nilai Pancasila.', 25, 60, 'flag', '#e11d48', '#ffe4e6', 15),

  -- Kelompok Bahasa Asing
  ('SMA', 'Bahasa Arab', 'Bahasa Arab SMA', 'bahasa_asing', 'Tata bahasa (nahwu/sharaf), mufradat, dan pemahaman teks Arab.', 25, 60, 'translate', '#15803d', '#dcfce7', 16),
  ('SMA', 'Bahasa Jerman', 'Bahasa Jerman SMA', 'bahasa_asing', 'Leseverstehen, Grammatik, dan Wortschatz Bahasa Jerman.', 25, 60, 'translate', '#b45309', '#fef3c7', 17),
  ('SMA', 'Bahasa Prancis', 'Bahasa Prancis SMA', 'bahasa_asing', 'Compréhension écrite, grammaire, et vocabulaire Bahasa Prancis.', 25, 60, 'translate', '#1d4ed8', '#dbeafe', 18),
  ('SMA', 'Bahasa Jepang', 'Bahasa Jepang SMA', 'bahasa_asing', 'Dokkai, bunpou, huruf Kana & Kanji dasar.', 25, 60, 'translate', '#be123c', '#ffe4e6', 19),
  ('SMA', 'Bahasa Korea', 'Bahasa Korea SMA', 'bahasa_asing', 'Reading comprehension, grammar (Munbeop), dan Hangeul.', 25, 60, 'translate', '#7e22ce', '#f3e8ff', 20),
  ('SMA', 'Bahasa Mandarin', 'Bahasa Mandarin SMA', 'bahasa_asing', 'Yuedu, Yufa, dan Hanzi dasar.', 25, 60, 'translate', '#c2410c', '#ffedd5', 21)
ON CONFLICT (education_level, name) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  group_category = EXCLUDED.group_category,
  description = EXCLUDED.description,
  question_count = EXCLUDED.question_count,
  duration_minutes = EXCLUDED.duration_minutes,
  icon = EXCLUDED.icon,
  icon_color = EXCLUDED.icon_color,
  bg_color = EXCLUDED.bg_color,
  display_order = EXCLUDED.display_order;
