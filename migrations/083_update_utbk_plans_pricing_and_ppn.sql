-- Migration 083: Update UTBK Plans Pricing, Discounts, Features, and add original_price & discount_percent to plans

-- 1. Add original_price and discount_percent columns to plans table if they don't exist
ALTER TABLE plans ADD COLUMN IF NOT EXISTS original_price INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS discount_percent INTEGER DEFAULT 0;

-- 2. Insert or update utbk_1m (Premium UTBK 1 Bulan)
INSERT INTO plans (
  name, display_name, description, price, original_price, discount_percent,
  duration_days, features, is_popular, sort_order, is_active, plan_type, target_type
) VALUES (
  'utbk_1m',
  'UTBK/SNBT 1 Bulan',
  'Akses Latihan Soal, Tryout, dan Rasionalisasi UTBK/SNBT selama 1 bulan',
  25000,
  25000,
  0,
  30,
  '["Akses semua latihan soal UTBK/SNBT", "Akses tryout UTBK/SNBT", "Fitur rasionalisasi peluang", "Pembahasan soal tryout", "Pembahasan berbasis AI"]'::jsonb,
  false,
  10,
  true,
  'subscription',
  'utbk'
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
  plan_type = 'subscription',
  target_type = 'utbk';

-- 3. Update utbk_3m (Premium UTBK 3 Bulan: Rp 60.000, Original: Rp 75.000, Diskon 20%)
UPDATE plans SET
  display_name = 'UTBK/SNBT 3 Bulan',
  description = 'Akses Fundamental, Latihan Soal, Tryout, dan Rasionalisasi UTBK/SNBT selama 3 bulan',
  price = 60000,
  original_price = 75000,
  discount_percent = 20,
  duration_days = 90,
  features = '["Akses penuh Fundamental UTBK (Materi & Kuis)", "Akses semua latihan soal UTBK/SNBT", "Akses tryout UTBK/SNBT", "Fitur rasionalisasi peluang", "Pembahasan soal tryout", "Pembahasan berbasis AI"]'::jsonb,
  sort_order = 11,
  is_active = true,
  is_popular = false
WHERE name = 'utbk_3m';

-- 4. Update utbk_6m (Premium UTBK 6 Bulan: Rp 100.000, Original: Rp 150.000, Diskon 33%)
UPDATE plans SET
  display_name = 'UTBK/SNBT 6 Bulan',
  description = 'Akses Fundamental, Latihan Soal, Tryout, dan Rasionalisasi UTBK/SNBT selama 6 bulan',
  price = 100000,
  original_price = 150000,
  discount_percent = 33,
  duration_days = 180,
  features = '["Akses penuh Fundamental UTBK (Materi & Kuis)", "Akses semua latihan soal UTBK/SNBT", "Akses tryout UTBK/SNBT", "Fitur rasionalisasi peluang", "Pembahasan soal tryout", "Pembahasan berbasis AI"]'::jsonb,
  sort_order = 12,
  is_active = true,
  is_popular = true
WHERE name = 'utbk_6m';

-- 5. Update utbk_9m (Premium UTBK 9 Bulan: Rp 120.000, Original: Rp 225.000, Diskon 46%)
UPDATE plans SET
  display_name = 'UTBK/SNBT 9 Bulan',
  description = 'Akses Fundamental, Latihan Soal, Tryout, dan Rasionalisasi UTBK/SNBT selama 9 bulan',
  price = 120000,
  original_price = 225000,
  discount_percent = 46,
  duration_days = 270,
  features = '["Akses penuh Fundamental UTBK (Materi & Kuis)", "Akses semua latihan soal UTBK/SNBT", "Akses tryout UTBK/SNBT", "Fitur rasionalisasi peluang", "Pembahasan soal tryout", "Pembahasan berbasis AI"]'::jsonb,
  sort_order = 13,
  is_active = true,
  is_popular = false
WHERE name = 'utbk_9m';

-- 6. Update utbk_12m (Premium UTBK 12 Bulan: Rp 150.000, Original: Rp 300.000, Diskon 50%)
UPDATE plans SET
  display_name = 'UTBK/SNBT 12 Bulan',
  description = 'Akses Fundamental, Latihan Soal, Tryout, dan Rasionalisasi UTBK/SNBT selama 12 bulan',
  price = 150000,
  original_price = 300000,
  discount_percent = 50,
  duration_days = 365,
  features = '["Akses penuh Fundamental UTBK (Materi & Kuis)", "Akses semua latihan soal UTBK/SNBT", "Akses tryout UTBK/SNBT", "Fitur rasionalisasi peluang", "Pembahasan soal tryout", "Pembahasan berbasis AI"]'::jsonb,
  sort_order = 14,
  is_active = true,
  is_popular = false
WHERE name = 'utbk_12m';
