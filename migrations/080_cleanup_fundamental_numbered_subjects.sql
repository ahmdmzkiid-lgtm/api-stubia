-- Migration: 080_cleanup_fundamental_numbered_subjects.sql
-- Description: Move any fundamental data from numbered subject copies (e.g. "Penalaran Umum 1") to the main standard subtest ("Penalaran Umum")

DO $$
DECLARE
    rec RECORD;
    target_id UUID;
    clean_title TEXT;
BEGIN
    FOR rec IN 
        SELECT id, title, name 
        FROM subjects 
        WHERE (title ~ '\s+\d+$' OR name ~ '\s+\d+$')
    LOOP
        -- Remove trailing number (e.g. 'Penalaran Umum 1' -> 'Penalaran Umum')
        clean_title := TRIM(REGEXP_REPLACE(COALESCE(rec.title, rec.name), '\s+\d+$', ''));
        
        -- Find clean target subject
        SELECT id INTO target_id 
        FROM subjects 
        WHERE (LOWER(TRIM(title)) = LOWER(clean_title) OR LOWER(TRIM(name)) = LOWER(clean_title))
          AND id != rec.id
          AND title !~ '\s+\d+$'
        LIMIT 1;

        IF target_id IS NOT NULL THEN
            -- Re-link fundamental materials
            UPDATE fundamental_materials 
            SET subject_id = target_id 
            WHERE subject_id = rec.id;

            -- Re-link fundamental drilling questions
            UPDATE fundamental_drilling_questions 
            SET subject_id = target_id 
            WHERE subject_id = rec.id;

            -- Re-link fundamental drilling sessions
            UPDATE fundamental_drilling_sessions 
            SET subject_id = target_id 
            WHERE subject_id = rec.id;
        END IF;
    END LOOP;
END $$;
