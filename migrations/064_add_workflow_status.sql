-- Migration 064: Add workflow_status to questions table
-- Status values: 'draft', 'under_review', 'approved'
-- All existing questions default to 'approved' to avoid disruption

ALTER TABLE questions
ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(20) NOT NULL DEFAULT 'draft'
  CHECK (workflow_status IN ('draft', 'under_review', 'approved'));

-- Grandfather all existing questions as 'approved' so they remain visible
UPDATE questions SET workflow_status = 'approved' WHERE workflow_status = 'draft';

CREATE INDEX IF NOT EXISTS idx_questions_workflow_status ON questions(workflow_status);
