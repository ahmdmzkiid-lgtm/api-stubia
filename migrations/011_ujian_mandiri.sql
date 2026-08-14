-- Ujian Mandiri tables

-- Main ujian mandiri (e.g. SIMAK UI, SM-ITB, UM-UGM)
CREATE TABLE IF NOT EXISTS ujian_mandiri (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  universitas VARCHAR(255) NOT NULL,
  nama_ujian VARCHAR(255) NOT NULL,
  status VARCHAR(30) DEFAULT 'open' CHECK (status IN ('open', 'coming-soon', 'closed')),
  deadline VARCHAR(255),
  lokasi VARCHAR(255),
  image TEXT,
  logo TEXT,
  detail_link TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tryout packages linked to ujian mandiri
CREATE TABLE IF NOT EXISTS um_tryout_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ujian_id UUID REFERENCES ujian_mandiri(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100) DEFAULT 'auto_stories',
  icon_color VARCHAR(20) DEFAULT '#0050cb',
  duration INT DEFAULT 120,
  peserta INT DEFAULT 0,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Latihan soal linked to ujian mandiri
CREATE TABLE IF NOT EXISTS um_latihan_soal (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ujian_id UUID REFERENCES ujian_mandiri(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  icon VARCHAR(100) DEFAULT 'auto_stories',
  icon_bg_color VARCHAR(20) DEFAULT '#0050cb',
  category_color VARCHAR(20) DEFAULT '#0050cb',
  button_style VARCHAR(20) DEFAULT 'filled',
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Questions for ujian mandiri (shared by tryout & latihan)
CREATE TABLE IF NOT EXISTS um_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tryout_package_id UUID REFERENCES um_tryout_packages(id) ON DELETE CASCADE,
  latihan_id UUID REFERENCES um_latihan_soal(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  CHECK (
    (tryout_package_id IS NOT NULL AND latihan_id IS NULL) OR
    (tryout_package_id IS NULL AND latihan_id IS NOT NULL)
  )
);

-- Answer choices for ujian mandiri questions
CREATE TABLE IF NOT EXISTS um_answer_choices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID REFERENCES um_questions(id) ON DELETE CASCADE,
  label CHAR(1) NOT NULL CHECK (label IN ('A','B','C','D','E')),
  content TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  explanation TEXT
);

-- Banner settings for ujian mandiri page
INSERT INTO site_settings (key, value) VALUES
  ('um_banner', '{"badge":"AKADEMIK 2026","title":"Eksplorasi Ujian Mandiri 2026","description":"Temukan peluang pendidikan terbaik di institusi pendidikan tinggi terkemuka Indonesia.","primaryButtonText":"Mulai Registrasi","primaryButtonLink":"","secondaryButtonText":"Unduh Panduan (PDF)","secondaryButtonLink":"","image":"https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=800","verifiedLabel":"TERVERIFIKASI","verifiedText":"Institusi Utama"}') 
ON CONFLICT (key) DO NOTHING;

-- Add peserta column if not exists (for existing databases)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'um_tryout_packages' AND column_name = 'peserta') THEN
    ALTER TABLE um_tryout_packages ADD COLUMN peserta INT DEFAULT 0;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ujian_mandiri_status ON ujian_mandiri(status);
CREATE INDEX IF NOT EXISTS idx_um_tryout_packages_ujian ON um_tryout_packages(ujian_id);
CREATE INDEX IF NOT EXISTS idx_um_latihan_soal_ujian ON um_latihan_soal(ujian_id);
CREATE INDEX IF NOT EXISTS idx_um_questions_tryout ON um_questions(tryout_package_id);
CREATE INDEX IF NOT EXISTS idx_um_questions_latihan ON um_questions(latihan_id);
CREATE INDEX IF NOT EXISTS idx_um_answer_choices_question ON um_answer_choices(question_id);
