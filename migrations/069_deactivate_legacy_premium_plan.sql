-- Migration: Deactivate legacy redundant 'premium' plan in favor of standardized 'utbk_6m' and duration packages
UPDATE plans
SET is_active = false
WHERE name = 'premium';
