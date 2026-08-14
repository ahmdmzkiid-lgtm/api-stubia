-- Migration: 052_add_roles_to_user_check_constraint.sql
-- Add new roles to user role check constraint for access control

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('student', 'admin', 'question_writer', 'quality_assurance', 'article_writer'));
