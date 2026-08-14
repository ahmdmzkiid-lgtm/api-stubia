-- Migration 058: Update certificates table for fellowship & create fellowship_buddies table

-- 1. Alter certificates table
-- Drop check constraint on program_type to allow 'fellowship' (or other strings)
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_program_type_check;

-- Add location and competencies columns to certificates
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS location VARCHAR(255) DEFAULT 'Jakarta';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS competencies TEXT[] DEFAULT '{}';

-- 2. Create fellowship_buddies table
CREATE TABLE IF NOT EXISTS fellowship_buddies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  photo_url TEXT NOT NULL,
  position VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
