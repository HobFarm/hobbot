-- Add replies tracking columns to daily_budget
-- Required for reply queue functionality

ALTER TABLE daily_budget ADD COLUMN replies_used INTEGER DEFAULT 0;
ALTER TABLE daily_budget ADD COLUMN replies_max INTEGER DEFAULT 50;
ALTER TABLE daily_budget ADD COLUMN last_reply_at TEXT;
