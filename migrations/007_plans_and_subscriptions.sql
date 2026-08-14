-- Plans & Subscriptions for Midtrans Payment Gateway

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  features JSONB DEFAULT '[]',
  is_popular BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  order_id VARCHAR(100) UNIQUE NOT NULL,
  midtrans_transaction_id VARCHAR(255),
  amount INTEGER NOT NULL,
  status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'capture', 'settlement', 'deny', 'cancel', 'expire', 'failure', 'refund')),
  payment_type VARCHAR(50),
  snap_token VARCHAR(255),
  snap_redirect_url TEXT,
  raw_response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_order ON payment_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON payment_transactions(status);

-- Add plan column to users for quick lookup
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN current_plan VARCHAR(50) DEFAULT 'gratis';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Seed default plans (yearly)
INSERT INTO plans (name, display_name, description, price, duration_days, features, is_popular, sort_order)
VALUES
  ('gratis', 'Gratis', 'Cocok untuk memulai persiapan UTBK', 0, 36500, '["Akses soal latihan dasar", "Tryout Mingguan", "Pembahasan soal terbatas"]', false, 1),
  ('premium', 'Premium', 'Tingkatkan persiapan UTBK-mu', 35000, 365, '["Akses semua latihan soal", "Pembahasan lengkap AI", "Analisis performa IRT", "10x Tryout beserta pembahasannya"]', true, 2),
  ('sultan', 'Sultan', 'Akses semua latihan soal dan tryout UTBK dan Ujian Mandiri', 160000, 365, '["Akses semua latihan soal UTBK & Ujian Mandiri", "Akses semua tryout UTBK & Ujian Mandiri", "Pembahasan soal berbasis AI sepuasnya", "Analisis performa & prediksi skor IRT"]', false, 3)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  duration_days = EXCLUDED.duration_days,
  features = EXCLUDED.features,
  is_popular = EXCLUDED.is_popular,
  sort_order = EXCLUDED.sort_order;
