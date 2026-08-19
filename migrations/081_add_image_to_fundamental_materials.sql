-- Migration: 081_add_image_to_fundamental_materials.sql
-- Description: Add image_url and image_position columns to fundamental_materials table

ALTER TABLE fundamental_materials
ADD COLUMN IF NOT EXISTS image_url TEXT,
ADD COLUMN IF NOT EXISTS image_position VARCHAR(20) DEFAULT 'before';
