-- Migration 085: Add and activate UTBK Tryout quota plans (1x, 3x, 5x, 10x, 15x) with progressive discounts up to max 50%

-- 1. Insert or update utbk_to_1x (1x Tryout UTBK-SNBT: Rp 10.000, Asli: Rp 15.000, Diskon 33%)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type, quota_limit
) VALUES (
  'utbk_to_1x',
  '1x Tryout UTBK-SNBT',
  'Kuota pengerjaan 1x Tryout UTBK/SNBT lengkap dengan pembahasan & analisis IRT',
  10000,
  15000,
  33,
  365,
  '["1x Kuota Tryout UTBK/SNBT", "Akses semua subtes dalam paket tryout", "Pembahasan lengkap berbasis AI", "Analisis skor IRT & peluang kelulusan", "Masa aktif kuota 1 tahun"]'::jsonb,
  false,
  15,
  true,
  'quota',
  'utbk',
  1
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  original_price = EXCLUDED.original_price,
  discount_percent = EXCLUDED.discount_percent,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  plan_type = 'quota',
  target_type = 'utbk',
  quota_limit = 1;

-- 2. Insert or update utbk_to_3x (3x Tryout UTBK-SNBT: Rp 28.000, Asli: Rp 45.000, Diskon 38%)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type, quota_limit
) VALUES (
  'utbk_to_3x',
  '3x Tryout UTBK-SNBT',
  'Kuota pengerjaan 3x Tryout UTBK/SNBT lengkap dengan pembahasan & analisis IRT',
  28000,
  45000,
  38,
  365,
  '["3x Kuota Tryout UTBK/SNBT", "Akses semua subtes dalam paket tryout", "Pembahasan lengkap berbasis AI", "Analisis skor IRT & peluang kelulusan", "Masa aktif kuota 1 tahun"]'::jsonb,
  false,
  16,
  true,
  'quota',
  'utbk',
  3
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  original_price = EXCLUDED.original_price,
  discount_percent = EXCLUDED.discount_percent,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  plan_type = 'quota',
  target_type = 'utbk',
  quota_limit = 3;

-- 3. Insert or update utbk_to_5x (5x Tryout UTBK-SNBT: Rp 43.000, Asli: Rp 75.000, Diskon 43%)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type, quota_limit
) VALUES (
  'utbk_to_5x',
  '5x Tryout UTBK-SNBT',
  'Kuota pengerjaan 5x Tryout UTBK/SNBT lengkap dengan pembahasan & analisis IRT',
  43000,
  75000,
  43,
  365,
  '["5x Kuota Tryout UTBK/SNBT", "Akses semua subtes dalam paket tryout", "Pembahasan lengkap berbasis AI", "Analisis skor IRT & peluang kelulusan", "Masa aktif kuota 1 tahun"]'::jsonb,
  false,
  17,
  true,
  'quota',
  'utbk',
  5
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  original_price = EXCLUDED.original_price,
  discount_percent = EXCLUDED.discount_percent,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  plan_type = 'quota',
  target_type = 'utbk',
  quota_limit = 5;

-- 4. Insert or update utbk_to_10x (10x Tryout UTBK-SNBT: Rp 79.000, Asli: Rp 150.000, Diskon 47%, Terpopuler)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type, quota_limit
) VALUES (
  'utbk_to_10x',
  '10x Tryout UTBK-SNBT',
  'Kuota pengerjaan 10x Tryout UTBK/SNBT lengkap dengan pembahasan & analisis IRT',
  79000,
  150000,
  47,
  365,
  '["10x Kuota Tryout UTBK/SNBT", "Akses semua subtes dalam paket tryout", "Pembahasan lengkap berbasis AI", "Analisis skor IRT & peluang kelulusan", "Masa aktif kuota 1 tahun"]'::jsonb,
  true,
  18,
  true,
  'quota',
  'utbk',
  10
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  original_price = 150000,
  discount_percent = 47,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = true,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  plan_type = 'quota',
  target_type = 'utbk',
  quota_limit = 10;

-- 5. Insert or update utbk_to_15x (15x Tryout UTBK-SNBT: Rp 112.000, Asli: Rp 225.000, Diskon 50% - Max Diskon)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type, quota_limit
) VALUES (
  'utbk_to_15x',
  '15x Tryout UTBK-SNBT',
  'Kuota pengerjaan 15x Tryout UTBK/SNBT lengkap dengan pembahasan & analisis IRT',
  112000,
  225000,
  50,
  365,
  '["15x Kuota Tryout UTBK/SNBT", "Akses semua subtes dalam paket tryout", "Pembahasan lengkap berbasis AI", "Analisis skor IRT & peluang kelulusan", "Masa aktif kuota 1 tahun"]'::jsonb,
  false,
  19,
  true,
  'quota',
  'utbk',
  15
)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  original_price = EXCLUDED.original_price,
  discount_percent = 50,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  plan_type = 'quota',
  target_type = 'utbk',
  quota_limit = 15;
