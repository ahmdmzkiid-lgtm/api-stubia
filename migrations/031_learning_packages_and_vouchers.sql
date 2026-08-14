-- Schema Update: Paket Belajar & Vouchers

-- 1. Modify plans table to support different plan types
ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'subscription' CHECK (plan_type IN ('subscription', 'quota', 'access'));
ALTER TABLE plans ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) DEFAULT 'utbk' CHECK (target_type IN ('utbk', 'um'));
ALTER TABLE plans ADD COLUMN IF NOT EXISTS quota_limit INTEGER DEFAULT NULL;

-- 2. Modify subscriptions table to support quota tracking
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS quota_remaining INTEGER DEFAULT NULL;

-- 3. Create vouchers table
CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(50) UNIQUE NOT NULL,
  discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value INTEGER NOT NULL,
  min_purchase INTEGER DEFAULT 0,
  max_discount INTEGER DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  usage_limit INTEGER DEFAULT NULL,
  usage_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast code verification
CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers(is_active);

-- 4. Create user_vouchers table to track voucher usage per user
CREATE TABLE IF NOT EXISTS user_vouchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  used_at TIMESTAMP DEFAULT NOW(),
  order_id VARCHAR(100) NOT NULL,
  UNIQUE(user_id, voucher_id)
);

-- 5. Modify payment_transactions: make plan_id nullable & add voucher_id
ALTER TABLE payment_transactions ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS voucher_id UUID REFERENCES vouchers(id) ON DELETE SET NULL;

-- 6. Create order_items table to support multi-item cart purchases
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID NOT NULL REFERENCES payment_transactions(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  price INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_tx ON order_items(transaction_id);

-- 7. Seed the 10 new learning packages
INSERT INTO plans (name, display_name, description, price, duration_days, features, is_popular, sort_order, plan_type, target_type, quota_limit)
VALUES
  (
    'utbk_3m',
    'UTBK/SNBT 3 Bulan',
    'Akses Latihan Soal & Tryout UTBK/SNBT selama 3 bulan',
    40000,
    90,
    '["Akses penuh latihan soal UTBK", "Akses penuh tryout UTBK", "Pembahasan berbasis AI", "Analisis performa IRT"]',
    false,
    10,
    'subscription',
    'utbk',
    NULL
  ),
  (
    'utbk_6m',
    'UTBK/SNBT 6 Bulan',
    'Akses Latihan Soal & Tryout UTBK/SNBT selama 6 bulan',
    70000,
    180,
    '["Akses penuh latihan soal UTBK", "Akses penuh tryout UTBK", "Pembahasan berbasis AI", "Analisis performa IRT"]',
    true,
    11,
    'subscription',
    'utbk',
    NULL
  ),
  (
    'utbk_9m',
    'UTBK/SNBT 9 Bulan',
    'Akses Latihan Soal & Tryout UTBK/SNBT selama 9 bulan',
    95000,
    270,
    '["Akses penuh latihan soal UTBK", "Akses penuh tryout UTBK", "Pembahasan berbasis AI", "Analisis performa IRT"]',
    false,
    12,
    'subscription',
    'utbk',
    NULL
  ),
  (
    'utbk_12m',
    'UTBK/SNBT 12 Bulan',
    'Akses Latihan Soal & Tryout UTBK/SNBT selama 12 bulan',
    110000,
    365,
    '["Akses penuh latihan soal UTBK", "Akses penuh tryout UTBK", "Pembahasan berbasis AI", "Analisis performa IRT"]',
    false,
    13,
    'subscription',
    'utbk',
    NULL
  ),
  (
    'utbk_to_5x',
    '5x Tryout UTBK/SNBT',
    'Kuota pengerjaan 5x Tryout UTBK/SNBT',
    25000,
    365,
    '["Kuota 5x Tryout SNBT/UTBK", "Pembahasan lengkap berbasis AI", "Analisis skor IRT", "Masa aktif 1 tahun"]',
    false,
    14,
    'quota',
    'utbk',
    5
  ),
  (
    'utbk_to_8x',
    '8x Tryout UTBK/SNBT',
    'Kuota pengerjaan 8x Tryout UTBK/SNBT',
    40000,
    365,
    '["Kuota 8x Tryout SNBT/UTBK", "Pembahasan lengkap berbasis AI", "Analisis skor IRT", "Masa aktif 1 tahun"]',
    false,
    15,
    'quota',
    'utbk',
    8
  ),
  (
    'utbk_to_10x',
    '10x Tryout UTBK/SNBT',
    'Kuota pengerjaan 10x Tryout UTBK/SNBT',
    45000,
    365,
    '["Kuota 10x Tryout SNBT/UTBK", "Pembahasan lengkap berbasis AI", "Analisis skor IRT", "Masa aktif 1 tahun"]',
    true,
    16,
    'quota',
    'utbk',
    10
  ),
  (
    'um_2m',
    'Ujian Mandiri 2 Bulan',
    'Akses Latihan & Tryout Ujian Mandiri selama 2 bulan',
    30000,
    60,
    '["Akses penuh latihan mandiri", "Akses penuh tryout mandiri", "Analisis & Pembahasan lengkap", "SIMAK UI, UTUL UGM, dll"]',
    false,
    17,
    'subscription',
    'um',
    NULL
  ),
  (
    'um_to_3x',
    '3x Tryout Ujian Mandiri',
    'Kuota pengerjaan 3x Tryout Ujian Mandiri',
    10000,
    365,
    '["Kuota 3x Tryout Ujian Mandiri", "Pembahasan & analisis lengkap", "SIMAK UI, UTUL UGM, dll", "Masa aktif 1 tahun"]',
    false,
    18,
    'quota',
    'um',
    3
  ),
  (
    'um_to_all',
    'Semua Tryout Ujian Mandiri',
    'Akses Tanpa Batas ke Semua Tryout Ujian Mandiri',
    20000,
    90,
    '["Akses tak terbatas Tryout Mandiri", "Pembahasan & analisis lengkap", "SIMAK UI, UTUL UGM, dll", "Masa aktif 3 bulan"]',
    true,
    19,
    'access',
    'um',
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
