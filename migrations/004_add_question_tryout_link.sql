-- Add tryout_package_id to questions so imported questions can be linked to a specific tryout package
-- NULL = latihan (general bank), UUID = linked to specific tryout package
ALTER TABLE questions ADD COLUMN IF NOT EXISTS tryout_package_id UUID REFERENCES tryout_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_questions_tryout_package ON questions(tryout_package_id);
