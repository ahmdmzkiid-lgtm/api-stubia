-- Add dual screenshot fields and platform selection to tryout_registrations
-- screenshot_follow_url: SS for following the account
-- screenshot_repost_url: SS for reposting the post
-- platform: 'instagram' or 'x' (Twitter)

ALTER TABLE tryout_registrations 
ADD COLUMN IF NOT EXISTS screenshot_follow_url TEXT,
ADD COLUMN IF NOT EXISTS screenshot_repost_url TEXT,
ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'instagram' CHECK (platform IN ('instagram', 'x'));

-- Migrate existing data: copy old screenshot_url to screenshot_follow_url
UPDATE tryout_registrations 
SET screenshot_follow_url = screenshot_url 
WHERE screenshot_follow_url IS NULL AND screenshot_url IS NOT NULL;

-- Make old screenshot_url column nullable (keep for backward compatibility)
ALTER TABLE tryout_registrations ALTER COLUMN screenshot_url DROP NOT NULL;
