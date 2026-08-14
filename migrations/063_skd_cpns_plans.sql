-- ============================================================
-- SKD CPNS: Plans / Paket Belajar
-- cpns_3m, cpns_6m, cpns_to_eceran, cpns_to_all
-- ============================================================

-- Extend target_type to include 'cpns'
ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_target_type_check;

ALTER TABLE plans
  ADD CONSTRAINT plans_target_type_check
  CHECK (target_type IN ('utbk', 'um', 'cpns'));

-- Seed SKD CPNS plans
INSERT INTO plans (name, display_name, description, price, duration_days, features, is_popular, sort_order, plan_type, target_type, quota_limit)
VALUES
  (
    'cpns_3m',
    'SKD CPNS 3 Bulan',
    'Akses penuh Latihan Soal & Tryout SKD CPNS selama 3 bulan',
    45000,
    90,
    '["Akses penuh latihan soal TWK, TIU, TKP", "Akses penuh tryout SKD CPNS", "Pembahasan lengkap setiap soal", "Analisis performa per subtes", "Simulasi passing grade SKD"]',
    false,
    20,
    'subscription',
    'cpns',
    NULL
  ),
  (
    'cpns_6m',
    'SKD CPNS 6 Bulan',
    'Akses penuh Latihan Soal & Tryout SKD CPNS selama 6 bulan',
    75000,
    180,
    '["Akses penuh latihan soal TWK, TIU, TKP", "Akses penuh tryout SKD CPNS", "Pembahasan lengkap setiap soal", "Analisis performa per subtes", "Simulasi passing grade SKD", "Akses 2x lebih lama"]',
    true,
    21,
    'subscription',
    'cpns',
    NULL
  ),
  (
    'cpns_to_eceran',
    '3x Tryout SKD CPNS',
    'Kuota pengerjaan 3x Tryout SKD CPNS',
    15000,
    365,
    '["Kuota 3x Tryout SKD CPNS", "Pembahasan lengkap setiap soal", "Simulasi passing grade SKD", "Masa aktif 1 tahun"]',
    false,
    22,
    'quota',
    'cpns',
    3
  ),
  (
    'cpns_to_all',
    'Semua Tryout SKD CPNS',
    'Akses tak terbatas ke semua Tryout SKD CPNS',
    25000,
    90,
    '["Akses tak terbatas Tryout SKD CPNS", "Pembahasan lengkap setiap soal", "Simulasi passing grade SKD", "Masa aktif 3 bulan"]',
    false,
    23,
    'access',
    'cpns',
    NULL
  )
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order,
  plan_type = EXCLUDED.plan_type,
  target_type = EXCLUDED.target_type,
  quota_limit = EXCLUDED.quota_limit;
