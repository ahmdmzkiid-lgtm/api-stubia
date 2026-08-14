-- Add bio column to team_members and seed the actual team members from HTML
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS bio TEXT;

-- Clear previous seeded members
DELETE FROM team_members;

-- Seed the actual team members with photo_urls and bios
INSERT INTO team_members (name, role, photo_url, bio, display_order)
VALUES 
  ('Aditya Wijaya', 'CEO & Founder', 'https://lh3.googleusercontent.com/aida-public/AB6AXuBgUk2fH6ac97y0IeoAg0KkxeybRBGdk8yWG_022H0RrtblIf22RauqROP1HuOtmGQdcR1FlFElAIjqEr3VnGAiWk_7dDTNxcdqGysTpncCKnGJNb7Pqx_H-_NoKcwQeiXZe2-foAdYoTipnIRFw9YofrlWVc2EdFX0_c_vsDxzb7RezrIUj1iuJboZnJgtA-kzU3qL10tJUDQVuaPnXC_Z0AjAW9xyiXqs-tCS4S1jxKEapIuxylvxowa8yymMxtquIUNqFcmrY_E', 'Berpengalaman lebih dari 15 tahun dalam transformasi pendidikan digital di Asia Tenggara.', 1),
  ('Siti Rahmawati', 'Head of Curriculum', 'https://lh3.googleusercontent.com/aida-public/AB6AXuA3RbsTPN4FYMbiHJekiZdE7kaU1J8UAmWmGN6z_1JkGTOOTotusmOi-Ch0MWjHwcCAevB9Fi-8eXpNRKzODdPjnZXNizSb9EmpFXxZpeMLt2EpS39OvdQ3wLWG0EyT-gQMYVioROQuWpU55rBj1VcTIsMKnUJbPS4amDuutjI4BrwYy8NI5_N9NVS079Kj9iJG7VXqqlghUiDCMWrZMVC9xGPws8f6wl4RD0ZjBff0CxV1ndzAAVi4T27Xd9aH3EkZ2vuhd93LKyI', 'Pakar pedagogi yang berfokus pada pengembangan modul pembelajaran berbasis kompetensi global.', 2),
  ('Budi Santoso', 'Lead Developer', 'https://lh3.googleusercontent.com/aida-public/AB6AXuCns7H5bH_p1Ex4LAiy_AKHFH3-G0cqoqNcJ1sn07QylkrWUx2r0A-wZW-Tng_xP8Kfnl5i-nBY4ee_DLrgK6-31asZT0cg-15O8f47qZqn0YZb9wQKIOB9YKTcBSggtjGXpIgclSEEsqN8bZG1gwJ5jiWQMtSH_GFvKqvfv0GQpoW_N8Jif4ctZQ5hzLE9pdve9Y0X5bGhPyU-gfsIhTw1xpTPMlYOe2nwgoEcX4bEYWa2pj83TD6ICe-Zdvz1w9tIivT2qmAmj-0', 'Arsitek sistem yang memastikan platform Stubia berjalan lancar dengan teknologi mutakhir.', 3),
  ('Maya Putri', 'Success Manager', 'https://lh3.googleusercontent.com/aida-public/AB6AXuCl-aK6YuG9G2dvwHVw9hoJSckdVkC_3qhG0AuNXW220OrCe9KJZKzAjcygBlWcw9BJj6UCmdvGcJJRwKwR-IQBISLTQG5zUar753Hvq5QEbUyIJ9EA60b2H2ODfFIq5JCmxsrwv6VI1PMzQDr3umAvt3MA3w6xVbNGT7o6WQ8CoJNqwfJh6Re9ipcmfsmiXEVeCorYyCrflcp9gBbeBNX4GHF0HgsB_JyUFjpWv6rPvmm0ZqQfaqiik1HWM1JKA_MnQPvDd7fs_7o', 'Berdedikasi untuk mendampingi setiap perjalanan belajar siswa hingga mencapai potensi maksimal.', 4);
