-- Set gratis plan is_active to false so it is not returned in listing
UPDATE plans
SET is_active = false
WHERE name = 'gratis';
