-- Migration 054: Update job vacancy type 'Volunter' to 'Volunteer' to fix typo
UPDATE job_vacancies 
SET type = 'Volunteer' 
WHERE type = 'Volunter';
