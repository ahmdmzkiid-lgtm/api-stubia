-- Access control toggles for tryout/latihan (UTBK & Mandiri)
-- Adds is_active and required_plan (where missing)

ALTER TABLE IF EXISTS tryout_packages
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

ALTER TABLE IF EXISTS um_tryout_packages
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS required_plan VARCHAR(20) DEFAULT 'gratis';

ALTER TABLE IF EXISTS um_latihan_soal
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS required_plan VARCHAR(20) DEFAULT 'gratis';

ALTER TABLE IF EXISTS subjects
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
