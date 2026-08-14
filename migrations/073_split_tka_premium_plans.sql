-- Migration 073: Split TKA Premium Plans by Education Level (SD, SMP, SMA)
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_target_type_check;
ALTER TABLE plans ADD CONSTRAINT plans_target_type_check CHECK (target_type IN ('utbk', 'um', 'cpns', 'tka', 'tka_sd', 'tka_smp', 'tka_sma'));

-- Insert 3 distinct TKA Premium plans
INSERT INTO plans (name, display_name, description, price, duration_days, features, plan_type, target_type, is_active)
VALUES
  ('tka_premium_sd', 'TKA Premium SD', 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SD.', 35000, 30, '["Akses semua latihan TKA SD", "Akses semua tryout TKA SD", "Analisis kelemahan per materi", "Pembahasan lengkap"]'::jsonb, 'subscription', 'tka_sd', TRUE),
  ('tka_premium_smp', 'TKA Premium SMP', 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SMP.', 50000, 30, '["Akses semua latihan TKA SMP", "Akses semua tryout TKA SMP", "Analisis kelemahan per materi", "Pembahasan lengkap"]'::jsonb, 'subscription', 'tka_smp', TRUE),
  ('tka_premium_sma', 'TKA Premium SMA', 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SMA.', 75000, 30, '["Akses semua latihan TKA SMA", "Akses semua tryout TKA SMA", "Analisis kelemahan per materi", "Pembahasan lengkap"]'::jsonb, 'subscription', 'tka_sma', TRUE)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  plan_type = EXCLUDED.plan_type,
  target_type = EXCLUDED.target_type,
  is_active = EXCLUDED.is_active;

-- Optionally deactivate generic tka_premium if needed
UPDATE plans SET is_active = FALSE WHERE name = 'tka_premium';
