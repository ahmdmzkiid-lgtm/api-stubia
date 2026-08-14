-- Migration: Deactivate/Remove Sultan and UTBK Quota/Eceran Plans
-- UTBK now strictly uses time-based subscription packages (3m, 6m, 9m, 12m)

UPDATE plans
SET is_active = false
WHERE name IN ('sultan', 'utbk_to_5x', 'utbk_to_8x', 'utbk_to_10x');
