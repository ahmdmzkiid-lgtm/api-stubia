-- Update default required_plan to premium and update existing tryout_packages from gratis to premium
ALTER TABLE IF EXISTS tryout_packages ALTER COLUMN required_plan SET DEFAULT 'premium';
UPDATE tryout_packages SET required_plan = 'premium' WHERE required_plan = 'gratis' OR required_plan IS NULL;

ALTER TABLE IF EXISTS um_tryout_packages ALTER COLUMN required_plan SET DEFAULT 'premium';
UPDATE um_tryout_packages SET required_plan = 'premium' WHERE required_plan = 'gratis' OR required_plan IS NULL;

ALTER TABLE IF EXISTS skd_tryout_packages ALTER COLUMN required_plan SET DEFAULT 'premium';
UPDATE skd_tryout_packages SET required_plan = 'premium' WHERE required_plan = 'gratis' OR required_plan IS NULL;
