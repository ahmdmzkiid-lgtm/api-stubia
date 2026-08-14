-- Create table for custom TKA practice package names
CREATE TABLE IF NOT EXISTS tka_latihan_package_names (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES tka_subjects(id) ON DELETE CASCADE,
  package_number INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject_id, package_number)
);
