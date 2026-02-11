-- Migration 019: Add title_hash for duplicate post detection
-- Prevents posting duplicate content to the same submolt

-- Column title_hash already exists on own_posts (applied manually before migration tracking)

CREATE INDEX IF NOT EXISTS idx_own_posts_title_hash_submolt
ON own_posts(title_hash, submolt, created_at DESC);
