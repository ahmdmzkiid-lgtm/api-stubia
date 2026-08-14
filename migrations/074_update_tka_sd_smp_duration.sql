-- Migration 074: Update TKA SD & SMP subject duration (75 mins) and question count (30 questions)
UPDATE tka_subjects
SET duration_minutes = 75, question_count = 30
WHERE education_level IN ('SD', 'SMP');
