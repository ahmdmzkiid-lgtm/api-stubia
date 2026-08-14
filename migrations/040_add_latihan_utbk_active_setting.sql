-- Adds default status setting for Latihan Soal UTBK
INSERT INTO site_settings (key, value) VALUES
  ('latihan_utbk_active', 'true')
ON CONFLICT (key) DO NOTHING;
