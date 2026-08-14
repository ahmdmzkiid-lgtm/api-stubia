-- Migration: Update Sultan plan details
UPDATE plans 
SET 
  price = 160000,
  description = 'Akses semua latihan soal dan tryout UTBK dan Ujian Mandiri',
  features = '["Akses semua latihan soal UTBK & Ujian Mandiri", "Akses semua tryout UTBK & Ujian Mandiri", "Pembahasan soal berbasis AI sepuasnya", "Analisis performa & prediksi skor IRT"]'
WHERE name = 'sultan';
