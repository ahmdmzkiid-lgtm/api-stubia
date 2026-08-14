-- Migration: 066_alter_workflow_status_default
-- Alters the default value of the workflow_status column in questions table to 'under_review'

ALTER TABLE questions ALTER COLUMN workflow_status SET DEFAULT 'under_review';
