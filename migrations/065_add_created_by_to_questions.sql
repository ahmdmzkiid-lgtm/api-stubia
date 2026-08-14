-- Migration: 065_add_created_by_to_questions
-- Adds a created_by column referencing the users table to track who created the UTBK/Latihan question.

ALTER TABLE questions ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
