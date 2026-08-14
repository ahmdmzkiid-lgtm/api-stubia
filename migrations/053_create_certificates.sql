CREATE TABLE IF NOT EXISTS certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  certificate_code VARCHAR(100) UNIQUE NOT NULL,
  recipient_name VARCHAR(255) NOT NULL,
  program_type VARCHAR(50) NOT NULL CHECK (program_type IN ('internship', 'volunteer')),
  position VARCHAR(255) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  signer_name VARCHAR(255) NOT NULL,
  signer_role VARCHAR(255) NOT NULL,
  signature_url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
