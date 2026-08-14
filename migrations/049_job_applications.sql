-- Migration 049: Create job_applications table

CREATE TABLE IF NOT EXISTS job_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vacancy_id UUID REFERENCES job_vacancies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  photo_url TEXT NOT NULL,
  cv_url TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_applications_vacancy ON job_applications(vacancy_id);
