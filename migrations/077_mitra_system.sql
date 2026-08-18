-- Migration 077: Mitra Affiliate System
-- Creates all tables required for mitra.stubia.id

-- 1. Mitra Users
CREATE TABLE IF NOT EXISTS mitra_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    ktp_number VARCHAR(30) NOT NULL,
    ktp_image_url TEXT,
    address TEXT NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    whatsapp VARCHAR(30) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    bank_account VARCHAR(100) NOT NULL,
    bank_holder VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    referral_code VARCHAR(50) UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    total_withdrawn INTEGER DEFAULT 0,
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),
    rejection_reason TEXT,
    approved_at TIMESTAMP,
    approved_by UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mitra_users_referral ON mitra_users(referral_code);
CREATE INDEX IF NOT EXISTS idx_mitra_users_email ON mitra_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_mitra_users_status ON mitra_users(status);

-- 2. Mitra Settings
CREATE TABLE IF NOT EXISTS mitra_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO mitra_settings (key, value) VALUES
    ('buyer_discount_percent', '10'),
    ('commission_percent', '10'),
    ('min_withdrawal', '50000'),
    ('cookie_days', '14')
ON CONFLICT (key) DO NOTHING;

-- 3. Mitra Clicks
CREATE TABLE IF NOT EXISTS mitra_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mitra_id UUID REFERENCES mitra_users(id) ON DELETE CASCADE,
    referral_code VARCHAR(50) NOT NULL,
    ip_address VARCHAR(100),
    user_agent TEXT,
    referrer_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mitra_clicks_mitra ON mitra_clicks(mitra_id);
CREATE INDEX IF NOT EXISTS idx_mitra_clicks_code ON mitra_clicks(referral_code);
CREATE INDEX IF NOT EXISTS idx_mitra_clicks_created ON mitra_clicks(created_at);

-- 4. Mitra Transactions
CREATE TABLE IF NOT EXISTS mitra_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mitra_id UUID REFERENCES mitra_users(id) ON DELETE CASCADE,
    order_id VARCHAR(100) NOT NULL,
    payment_transaction_id UUID REFERENCES payment_transactions(id) ON DELETE SET NULL,
    buyer_name VARCHAR(255),
    buyer_email VARCHAR(255),
    product_name VARCHAR(255) NOT NULL,
    total_price INTEGER NOT NULL,
    discount_amount INTEGER DEFAULT 0,
    commission_amount INTEGER NOT NULL,
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'cancelled')),
    settled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mitra_tx_mitra ON mitra_transactions(mitra_id);
CREATE INDEX IF NOT EXISTS idx_mitra_tx_order ON mitra_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_mitra_tx_status ON mitra_transactions(status);

-- 5. Mitra Missions
CREATE TABLE IF NOT EXISTS mitra_missions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    target_type VARCHAR(50) DEFAULT 'transaction_count' CHECK (target_type IN ('transaction_count', 'total_revenue')),
    target_value INTEGER NOT NULL,
    reward_amount INTEGER NOT NULL,
    reward_type VARCHAR(50) DEFAULT 'balance' CHECK (reward_type IN ('balance', 'bonus_percent')),
    category VARCHAR(50) DEFAULT 'pemula' CHECK (category IN ('pemula', 'bulanan', 'khusus')),
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Seed default initial missions
INSERT INTO mitra_missions (name, description, target_type, target_value, reward_amount, reward_type, category, is_active) VALUES
    ('Transaksi Perdana', 'Capai 1 transaksi pertama dari link referral Anda untuk mendapatkan bonus permulaan.', 'transaction_count', 1, 15000, 'balance', 'pemula', TRUE),
    ('Misi Pejuang Bulan Ini', 'Capai 10 transaksi sukses dalam bulan ini untuk mendapatkan bonus loyalitas.', 'transaction_count', 10, 100000, 'balance', 'bulanan', TRUE),
    ('Master Affiliate', 'Raih total omzet referral minimal Rp 1.000.000 untuk reward spesial.', 'total_revenue', 1000000, 150000, 'balance', 'khusus', TRUE)
ON CONFLICT DO NOTHING;

-- 6. Mitra Mission Progress
CREATE TABLE IF NOT EXISTS mitra_mission_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mitra_id UUID REFERENCES mitra_users(id) ON DELETE CASCADE,
    mission_id UUID REFERENCES mitra_missions(id) ON DELETE CASCADE,
    current_progress INTEGER DEFAULT 0,
    is_completed BOOLEAN DEFAULT FALSE,
    is_claimed BOOLEAN DEFAULT FALSE,
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(mitra_id, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_mitra_mp_mitra ON mitra_mission_progress(mitra_id);
CREATE INDEX IF NOT EXISTS idx_mitra_mp_mission ON mitra_mission_progress(mission_id);

-- 7. Mitra Withdrawals
CREATE TABLE IF NOT EXISTS mitra_withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mitra_id UUID REFERENCES mitra_users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    bank_account VARCHAR(100) NOT NULL,
    bank_holder VARCHAR(255) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_notes TEXT,
    transfer_proof_url TEXT,
    processed_by UUID,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mitra_wd_mitra ON mitra_withdrawals(mitra_id);
CREATE INDEX IF NOT EXISTS idx_mitra_wd_status ON mitra_withdrawals(status);

-- 8. Mitra Marketing Kits
CREATE TABLE IF NOT EXISTS mitra_marketing_kits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('banner', 'text_template', 'brochure')),
    file_url TEXT,
    preview_url TEXT,
    description TEXT,
    copy_text TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Seed marketing kits
INSERT INTO mitra_marketing_kits (title, type, description, copy_text, display_order, is_active) VALUES
    ('Template Broadcast WhatsApp Promo UTBK', 'text_template', 'Template pesan WhatsApp siap kirim ke grup belajar / teman.', '🔥 *PERSIAPAN UTBK SNBT 2025/2026 MAKIN MATANG DENGAN STUBIA!* 🔥\n\nYuk latihan ribuan soal UTBK & Ujian Mandiri dengan sistem IRT real-time, pembahasan super lengkap, dan analitik cerdas di *Stubia.id*!\n\n🎁 Dapatkan diskon langsung 10% dengan link khusus:\n👉 {REFERRAL_LINK}\n\nAtau gunakan kode promo: *{REFERRAL_CODE}*\n\nJangan tunda belajar, raih PTN impianmu sekarang! 🚀🎓', 1, TRUE),
    ('Template Caption Instagram / TikTok', 'text_template', 'Caption singkat & engaging untuk feeds / story media sosial.', 'Mau lolos PTN favorit tanpa overthinking? Cobain platform tryout UTBK & Ujian Mandiri terlengkap di @stubia.id ✨\n\nKlik link di bio atau gunakan kode voucher "{REFERRAL_CODE}" buat klaim diskon 10%! 🎯\n\n#UTBK2025 #SNBT #MasukPTN #Stubia #TryoutUTBK', 2, TRUE),
    ('Template Broadcast Telegram Diskusi Soal', 'text_template', 'Template pesan untuk channel Telegram siswa/ambis UTBK.', '📚 *INFO TRYOUT & BANK SOAL UTBK GRATIS & PREMIUM*\n\nBuat teman-teman yang lagi cari bank soal UTBK SNBT terupdate dengan sistem CBT asli:\n\n✨ Akses ribuan latihan soal adaptif\n✨ Tryout berkala dengan IRT scoring\n✨ Pembahasan interaktif AI + Tutor\n\nKlaim potongan 10% paket belajar:\n➡️ {REFERRAL_LINK} (Kode: {REFERRAL_CODE})\n\nSemangat pejuang PTN! 💪', 3, TRUE)
ON CONFLICT DO NOTHING;

-- 9. Mitra Announcements
CREATE TABLE IF NOT EXISTS mitra_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(30) DEFAULT 'info' CHECK (type IN ('info', 'promo', 'warning', 'success')),
    badge_text VARCHAR(50),
    action_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO mitra_announcements (title, message, type, badge_text, is_active) VALUES
    ('Selamat Datang di Program Mitra Stubia! 🎉', 'Mulai bagikan link referral Anda ke media sosial, grup WhatsApp, atau teman untuk mendapatkan komisi hingga 10% dari setiap transaksi.', 'promo', 'PENTING', TRUE),
    ('Misi Baru: Raih Transaksi Perdana!', 'Dapatkan bonus saldo langsung Rp 15.000 setelah berhasil mendapatkan transaksi referral pertama Anda.', 'success', 'MISI AKTIF', TRUE)
ON CONFLICT DO NOTHING;

-- 10. Alter payment_transactions table to add referral tracking columns
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_transactions' AND column_name = 'referral_code') THEN
        ALTER TABLE payment_transactions ADD COLUMN referral_code VARCHAR(50);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_transactions' AND column_name = 'mitra_id') THEN
        ALTER TABLE payment_transactions ADD COLUMN mitra_id UUID REFERENCES mitra_users(id) ON DELETE SET NULL;
    END IF;
END $$;
