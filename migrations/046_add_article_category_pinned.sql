-- Migration 046: Add category and is_pinned columns to articles table

ALTER TABLE articles ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Umum';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
