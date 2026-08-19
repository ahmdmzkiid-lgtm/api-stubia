-- Migration: 079_fundamental_passing_score.sql
-- Description: Add passing_score column to fundamental_materials (KKM / minimum score required to pass quiz and unlock next material)

ALTER TABLE fundamental_materials
ADD COLUMN IF NOT EXISTS passing_score INT NOT NULL DEFAULT 70;
