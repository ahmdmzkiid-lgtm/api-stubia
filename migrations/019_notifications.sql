CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  is_read BOOLEAN DEFAULT false,
  is_modal_shown BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for querying user notifications quickly
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
