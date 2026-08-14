-- Add instagram_url and linkedin_url to team_members
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS linkedin_url TEXT;

-- Update existing seeded team members with sample profiles (which can be edited via admin panel)
UPDATE team_members SET 
  instagram_url = 'https://instagram.com/aditya.wijaya',
  linkedin_url = 'https://linkedin.com/in/aditya-wijaya'
WHERE name = 'Aditya Wijaya';

UPDATE team_members SET 
  instagram_url = 'https://instagram.com/siti.rahmawati',
  linkedin_url = 'https://linkedin.com/in/siti-rahmawati'
WHERE name = 'Siti Rahmawati';

UPDATE team_members SET 
  instagram_url = 'https://instagram.com/budi.santoso',
  linkedin_url = 'https://linkedin.com/in/budi-santoso'
WHERE name = 'Budi Santoso';

UPDATE team_members SET 
  instagram_url = 'https://instagram.com/maya.putri',
  linkedin_url = 'https://linkedin.com/in/maya-putri'
WHERE name = 'Maya Putri';
