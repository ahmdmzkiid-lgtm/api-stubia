-- Add package_name to um_latihan_soal for grouping exercises
ALTER TABLE um_latihan_soal ADD COLUMN IF NOT EXISTS package_name VARCHAR(100) DEFAULT 'Paket 1';
