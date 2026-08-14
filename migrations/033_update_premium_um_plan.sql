-- Migration: Update premium_um (Premium Ujian Mandiri) plan to match the new Ujian Mandiri 2 Bulan price & features
UPDATE plans 
SET 
  price = 30000,
  display_name = 'Premium Ujian Mandiri 2 Bulan',
  description = 'Akses Latihan & Tryout Ujian Mandiri selama 2 bulan',
  features = '["Akses penuh latihan mandiri", "Akses penuh tryout mandiri", "Analisis & Pembahasan lengkap", "SIMAK UI, UTUL UGM, dll"]'
WHERE name = 'premium_um';
