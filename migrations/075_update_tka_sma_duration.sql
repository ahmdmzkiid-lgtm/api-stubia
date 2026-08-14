-- Migration 075: Update TKA SMA subject duration & question count

-- 1. SMA Mapel Wajib
UPDATE tka_subjects
SET duration_minutes = 75, question_count = 25
WHERE education_level = 'SMA' AND group_category = 'wajib' AND name = 'Matematika';

UPDATE tka_subjects
SET duration_minutes = 75, question_count = 30
WHERE education_level = 'SMA' AND group_category = 'wajib' AND name = 'Bahasa Indonesia';

UPDATE tka_subjects
SET duration_minutes = 75, question_count = 30
WHERE education_level = 'SMA' AND group_category = 'wajib' AND name = 'Bahasa Inggris';

-- 2. SMA Mapel Pilihan (seluruh mapel selain wajib)
UPDATE tka_subjects
SET duration_minutes = 60, question_count = 25
WHERE education_level = 'SMA' AND group_category != 'wajib';
