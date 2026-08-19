-- Migration: 078_fundamental_utbk.sql
-- Description: Create tables for Fundamental UTBK-SNBT (Materials, Quizzes, Drilling, and Progress tracking)

-- 1. Fundamental Materials Table (Materi Pembelajaran per Subtes)
CREATE TABLE IF NOT EXISTS fundamental_materials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    content TEXT NOT NULL, -- Rich HTML / Markdown content with LaTeX and images
    order_index INT NOT NULL DEFAULT 1,
    estimated_read_minutes INT NOT NULL DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_materials_subject_id ON fundamental_materials(subject_id);
CREATE INDEX IF NOT EXISTS idx_fundamental_materials_order ON fundamental_materials(subject_id, order_index);

-- 2. Fundamental Quizzes Table (10 Soal Kuis per Materi)
CREATE TABLE IF NOT EXISTS fundamental_quizzes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    material_id UUID NOT NULL REFERENCES fundamental_materials(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    stimulus TEXT,
    image_url TEXT,
    image_position VARCHAR(20) DEFAULT 'after',
    difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    display_order INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_quizzes_material_id ON fundamental_quizzes(material_id);
CREATE INDEX IF NOT EXISTS idx_fundamental_quizzes_order ON fundamental_quizzes(material_id, display_order);

-- 3. Fundamental Quiz Options Table (Pilihan Jawaban Kuis)
CREATE TABLE IF NOT EXISTS fundamental_quiz_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quiz_id UUID NOT NULL REFERENCES fundamental_quizzes(id) ON DELETE CASCADE,
    label CHAR(1) NOT NULL, -- 'A', 'B', 'C', 'D', 'E'
    content TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    explanation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_quiz_options_quiz_id ON fundamental_quiz_options(quiz_id);

-- 4. Fundamental Drilling Questions Table (Bank Soal Drilling per Subtes)
CREATE TABLE IF NOT EXISTS fundamental_drilling_questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    stimulus TEXT,
    image_url TEXT,
    image_position VARCHAR(20) DEFAULT 'after',
    difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    display_order INT NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_drilling_subject_id ON fundamental_drilling_questions(subject_id);

-- 5. Fundamental Drilling Options Table (Pilihan Jawaban Drilling)
CREATE TABLE IF NOT EXISTS fundamental_drilling_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drilling_question_id UUID NOT NULL REFERENCES fundamental_drilling_questions(id) ON DELETE CASCADE,
    label CHAR(1) NOT NULL, -- 'A', 'B', 'C', 'D', 'E'
    content TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    explanation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_drilling_options_qid ON fundamental_drilling_options(drilling_question_id);

-- 6. Fundamental User Progress Table (Pelacakan Kemajuan Materi & Kuis Siswa)
CREATE TABLE IF NOT EXISTS fundamental_user_progress (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES fundamental_materials(id) ON DELETE CASCADE,
    is_material_read BOOLEAN NOT NULL DEFAULT FALSE,
    is_quiz_passed BOOLEAN NOT NULL DEFAULT FALSE,
    best_quiz_score INT NOT NULL DEFAULT 0, -- Nilai kuis terbaik (0 - 100)
    attempts_count INT NOT NULL DEFAULT 0,
    completed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_fundamental_user_material UNIQUE (user_id, material_id)
);

CREATE INDEX IF NOT EXISTS idx_fundamental_user_progress_user ON fundamental_user_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_fundamental_user_progress_material ON fundamental_user_progress(material_id);

-- 7. Fundamental Quiz Sessions Table (Log Pengerjaan Kuis Siswa)
CREATE TABLE IF NOT EXISTS fundamental_quiz_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES fundamental_materials(id) ON DELETE CASCADE,
    total_questions INT NOT NULL DEFAULT 10,
    correct_count INT NOT NULL DEFAULT 0,
    incorrect_count INT NOT NULL DEFAULT 0,
    unanswered_count INT NOT NULL DEFAULT 0,
    score FLOAT NOT NULL DEFAULT 0, -- Nilai 0 - 100
    is_passed BOOLEAN NOT NULL DEFAULT FALSE,
    answers_payload JSONB NOT NULL DEFAULT '[]', -- Rekap jawaban siswa
    time_spent_seconds INT NOT NULL DEFAULT 0,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_quiz_sessions_user ON fundamental_quiz_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_fundamental_quiz_sessions_material ON fundamental_quiz_sessions(material_id);

-- 8. Fundamental Drilling Sessions Table (Log Pengerjaan Drilling Soal Siswa)
CREATE TABLE IF NOT EXISTS fundamental_drilling_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    total_questions INT NOT NULL DEFAULT 0,
    correct_count INT NOT NULL DEFAULT 0,
    incorrect_count INT NOT NULL DEFAULT 0,
    unanswered_count INT NOT NULL DEFAULT 0,
    score FLOAT NOT NULL DEFAULT 0, -- Nilai 0 - 100
    answers_payload JSONB NOT NULL DEFAULT '[]',
    time_spent_seconds INT NOT NULL DEFAULT 0,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundamental_drilling_sessions_user ON fundamental_drilling_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_fundamental_drilling_sessions_subject ON fundamental_drilling_sessions(subject_id);
