-- Migration: Update features in plans table for UTBK 3m, 6m, 9m, 12m to include Fundamental UTBK
UPDATE plans
SET features = '["Akses penuh Fundamental UTBK (Materi & Kuis)", "Akses penuh latihan soal UTBK", "Akses penuh tryout UTBK", "Pembahasan berbasis AI", "Analisis performa IRT"]'::jsonb
WHERE name IN ('utbk_3m', 'utbk_6m', 'utbk_9m', 'utbk_12m');
