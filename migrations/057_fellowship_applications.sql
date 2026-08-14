-- Migration 057: Create fellowship_applications table

CREATE TABLE IF NOT EXISTS fellowship_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  registration_number VARCHAR(50) UNIQUE,
  name VARCHAR(255) NOT NULL,
  university VARCHAR(255) NOT NULL,
  major_year VARCHAR(255) NOT NULL,
  whatsapp VARCHAR(50) NOT NULL,
  position VARCHAR(100) NOT NULL,
  subjects TEXT[],
  duration VARCHAR(50) NOT NULL,
  start_availability VARCHAR(255),
  motivation TEXT,
  cv_url TEXT NOT NULL,
  photo_url TEXT NOT NULL,
  portfolio_url TEXT,
  commitment_agreed BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fellowship_applications_status ON fellowship_applications(status);
CREATE INDEX IF NOT EXISTS idx_fellowship_applications_position ON fellowship_applications(position);
