-- Extend latihan social verification with follow/tag-3 proof fields
ALTER TABLE user_social_verifications
  ADD COLUMN IF NOT EXISTS platform VARCHAR(20),
  ADD COLUMN IF NOT EXISTS social_username VARCHAR(150),
  ADD COLUMN IF NOT EXISTS comment_link TEXT,
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
