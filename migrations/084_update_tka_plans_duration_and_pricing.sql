-- Migration 084: Update TKA Plans Duration (2 Months / 60 Days) and Pricing
-- TKA SD: 2 Bulan, Rp 30.000
-- TKA SMP: 2 Bulan, Rp 40.000
-- TKA SMA: 2 Bulan, Rp 50.000

UPDATE plans
SET 
  price = 30000,
  duration_days = 60,
  description = 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SD selama 2 bulan.'
WHERE name = 'tka_premium_sd';

UPDATE plans
SET 
  price = 40000,
  duration_days = 60,
  description = 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SMP selama 2 bulan.'
WHERE name = 'tka_premium_smp';

UPDATE plans
SET 
  price = 50000,
  duration_days = 60,
  description = 'Akses penuh ke seluruh Latihan & Tryout TKA Jenjang SMA selama 2 bulan.'
WHERE name = 'tka_premium_sma';
