-- Tryout Registrations: Social media verification for free plan users
CREATE TABLE IF NOT EXISTS tryout_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  package_type VARCHAR(10) NOT NULL CHECK (package_type IN ('utbk', 'um')),
  utbk_package_id UUID REFERENCES tryout_packages(id) ON DELETE SET NULL,
  um_package_id UUID REFERENCES um_tryout_packages(id) ON DELETE SET NULL,
  screenshot_url TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  admin_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (
    (package_type = 'utbk' AND utbk_package_id IS NOT NULL AND um_package_id IS NULL) OR
    (package_type = 'um' AND um_package_id IS NOT NULL AND utbk_package_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tryout_reg_user ON tryout_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_tryout_reg_status ON tryout_registrations(status);
CREATE INDEX IF NOT EXISTS idx_tryout_reg_created ON tryout_registrations(created_at);
