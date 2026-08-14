-- Add custom scoring points to um_tryout_packages
ALTER TABLE um_tryout_packages ADD COLUMN IF NOT EXISTS points_correct INT DEFAULT 4;
ALTER TABLE um_tryout_packages ADD COLUMN IF NOT EXISTS points_incorrect INT DEFAULT -1;
ALTER TABLE um_tryout_packages ADD COLUMN IF NOT EXISTS points_unanswered INT DEFAULT 0;

-- Add custom scoring points to um_latihan_soal
ALTER TABLE um_latihan_soal ADD COLUMN IF NOT EXISTS points_correct INT DEFAULT 4;
ALTER TABLE um_latihan_soal ADD COLUMN IF NOT EXISTS points_incorrect INT DEFAULT -1;
ALTER TABLE um_latihan_soal ADD COLUMN IF NOT EXISTS points_unanswered INT DEFAULT 0;

-- Add latihan_id reference to latihan_sessions for tracking UM latihan history
ALTER TABLE latihan_sessions ADD COLUMN IF NOT EXISTS latihan_id UUID REFERENCES um_latihan_soal(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_latihan_sessions_latihan_id ON latihan_sessions(latihan_id);
