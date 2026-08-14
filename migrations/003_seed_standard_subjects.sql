-- Add unique constraint on name so we can safely insert without duplicates
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'subjects_name_unique'
    ) THEN
        ALTER TABLE subjects ADD CONSTRAINT subjects_name_unique UNIQUE (name);
    END IF;
END $$;

-- Insert the 7 standard UTBK subtests (skip if already exist)
INSERT INTO subjects (name, title, description, icon, bg_color, icon_color, category) VALUES
('Penalaran Umum', 'Penalaran Umum', 'Menguji kemampuan memecahkan masalah baru yang belum pernah dihadapi sebelumnya.', 'psychology', '#dae1ff', '#0050cb', 'TPS'),
('Pengetahuan dan Pemahaman Umum', 'Pengetahuan dan Pemahaman Umum', 'Menguji kemampuan untuk memahami dan mengomunikasikan pengetahuan yang dianggap penting.', 'menu_book', '#c2e8ff', '#006688', 'TPS'),
('Pemahaman Bacaan dan Tulisan', 'Pemahaman Bacaan dan Tulisan', 'Menguji kemampuan dalam memahami wacana tertulis dan menulis dengan baik.', 'description', '#ffdbd0', '#a33200', 'TPS'),
('Pengetahuan Kuantitatif', 'Pengetahuan Kuantitatif', 'Menguji pengetahuan dan penguasaan matematika dasar.', 'calculate', '#80f2f2', '#006a6a', 'TPS'),
('Literasi Bahasa Indonesia', 'Literasi Bahasa Indonesia', 'Menguji kemampuan memahami isi bacaan, mengevaluasi, dan merefleksikan teks.', 'translate', '#dae1ff', '#0050cb', 'TPS'),
('Literasi Bahasa Inggris', 'Literasi Bahasa Inggris', 'Menguji kemampuan memahami teks bacaan dalam Bahasa Inggris.', 'language', '#c2e8ff', '#006688', 'TPS'),
('Penalaran Matematika', 'Penalaran Matematika', 'Menguji kemampuan menyelesaikan masalah dalam konteks matematika kehidupan sehari-hari.', 'functions', '#ffdbd0', '#a33200', 'TPS')
ON CONFLICT DO NOTHING;
