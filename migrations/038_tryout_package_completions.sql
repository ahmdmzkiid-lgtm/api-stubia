-- Track one-time tryout package completion for free users (UTBK multi-subtes + UM)
CREATE TABLE IF NOT EXISTS tryout_package_completions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  package_type VARCHAR(10) NOT NULL,
  package_id UUID NOT NULL,
  completed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, package_type, package_id)
);

CREATE INDEX IF NOT EXISTS idx_tryout_package_completions_user
  ON tryout_package_completions(user_id);
