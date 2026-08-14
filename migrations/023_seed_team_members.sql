-- Seed initial team members
INSERT INTO team_members (name, role, display_order)
VALUES 
  ('Stu', 'Founder & Lead Mentor', 1),
  ('Barih', 'Lead Developer', 2),
  ('Stubia Team', 'Support Specialist', 3)
ON CONFLICT DO NOTHING;
