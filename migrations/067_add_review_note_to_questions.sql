-- Migration: 067_add_review_note_to_questions
-- Adds a review_note column to the questions table to store reviewer notes/comments

ALTER TABLE questions ADD COLUMN IF NOT EXISTS review_note TEXT;
