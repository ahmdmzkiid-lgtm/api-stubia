-- Question Item Statistics for IRT Calibration
-- Tracks empirical data about how students perform on each question
-- Used to calibrate IRT parameters (a, b, c) from real student data

CREATE TABLE IF NOT EXISTS question_item_stats (
  question_id UUID PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  total_attempts INT DEFAULT 0,
  total_correct INT DEFAULT 0,
  p_value FLOAT DEFAULT 0.5,           -- proportion correct (empirical difficulty)
  discrimination FLOAT DEFAULT 1.0,     -- empirical discrimination
  irt_a FLOAT DEFAULT 1.0,             -- calibrated discrimination parameter
  irt_b FLOAT DEFAULT 0.0,             -- calibrated difficulty parameter
  irt_c FLOAT DEFAULT 0.10,            -- guessing parameter
  last_calibrated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_item_stats_attempts ON question_item_stats(total_attempts);
CREATE INDEX IF NOT EXISTS idx_question_item_stats_p_value ON question_item_stats(p_value);
