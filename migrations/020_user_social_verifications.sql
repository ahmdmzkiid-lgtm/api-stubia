-- Social verification requests for latihan access
CREATE TABLE IF NOT EXISTS user_social_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  context VARCHAR(50) DEFAULT 'latihan',
  ig_username VARCHAR(150),
  x_username VARCHAR(150),
  status VARCHAR(20) DEFAULT 'pending', -- pending | approved | rejected
  rejection_reason TEXT,
  approved_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_social_verifications_user ON user_social_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_social_verifications_context ON user_social_verifications(context);
