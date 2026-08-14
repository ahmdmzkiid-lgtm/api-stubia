-- Add social verification fields to tryout_registrations
-- Replaces screenshot-based proof with username + comment link approach
ALTER TABLE tryout_registrations
  ADD COLUMN IF NOT EXISTS social_username VARCHAR(150),
  ADD COLUMN IF NOT EXISTS comment_link TEXT;
