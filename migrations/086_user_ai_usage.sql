-- Migration 086: User AI Usage tracking for monthly limits
CREATE TABLE IF NOT EXISTS user_ai_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month_year VARCHAR(7) NOT NULL, -- e.g. '2026-08'
    message_count INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT user_ai_usage_user_month_unique UNIQUE (user_id, month_year)
);

CREATE INDEX IF NOT EXISTS idx_user_ai_usage_user_month ON user_ai_usage(user_id, month_year);
