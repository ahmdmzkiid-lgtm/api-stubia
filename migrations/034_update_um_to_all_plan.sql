-- Migration: Update um_to_all plan duration to 90 days (3 months) and adjust features text
UPDATE plans 
SET 
  duration_days = 90,
  features = '["Akses tak terbatas Tryout Mandiri", "Pembahasan & analisis lengkap", "SIMAK UI, UTUL UGM, dll", "Masa aktif 3 bulan"]'
WHERE name = 'um_to_all';
