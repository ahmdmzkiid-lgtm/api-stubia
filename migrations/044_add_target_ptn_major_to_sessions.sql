-- Add target_ptn and target_major to tryout_sessions table
ALTER TABLE tryout_sessions
  ADD COLUMN IF NOT EXISTS target_ptn VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS target_major VARCHAR(255) DEFAULT NULL;
