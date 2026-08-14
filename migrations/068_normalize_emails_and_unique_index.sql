-- Normalize existing user emails to lower-case and trim whitespace
-- Resolve any case-variant duplicate emails by appending a unique suffix to newer duplicates
WITH duplicates AS (
  SELECT id, email, created_at,
         ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(email)) ORDER BY created_at ASC, id ASC) as rn
  FROM users
)
UPDATE users
SET email = LOWER(TRIM(users.email)) || '_dup_' || SUBSTRING(users.id::text, 1, 8)
FROM duplicates
WHERE users.id = duplicates.id AND duplicates.rn > 1;

-- Lowercase and trim all remaining emails
UPDATE users
SET email = LOWER(TRIM(email))
WHERE email != LOWER(TRIM(email));

-- Create unique index on LOWER(email) to enforce case-insensitive email uniqueness at DB layer
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
