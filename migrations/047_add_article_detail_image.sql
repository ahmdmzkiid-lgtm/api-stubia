-- Migration 047: Add detail_image to articles table

ALTER TABLE articles ADD COLUMN IF NOT EXISTS detail_image TEXT;
