-- Migration: Move premium_um target_type to 'um' and disable the duplicate um_2m plan
UPDATE plans 
SET target_type = 'um' 
WHERE name = 'premium_um';

UPDATE plans 
SET is_active = false 
WHERE name = 'um_2m';
