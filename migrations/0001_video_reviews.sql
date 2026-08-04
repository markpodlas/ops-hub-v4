-- Video Review module — QA reports for short nursing-education videos.
-- Applied against the existing `content-calendar` D1 database (binding: DB):
--   npx wrangler d1 migrations apply content-calendar --remote
--
-- Kept in sync with the lazy CREATE TABLE block in ensureVideoReviewTables()
-- in src/video-review.js — change one, change the other.

CREATE TABLE IF NOT EXISTS video_reviews (
  id                 TEXT PRIMARY KEY,
  video_url          TEXT NOT NULL,
  video_meta         TEXT,                            -- JSON, caller-supplied
  recommendation     TEXT,
  needs_human_nurse  INTEGER NOT NULL DEFAULT 1,      -- fail safe: escalate
  review_json        TEXT NOT NULL,
  input_tokens       INTEGER DEFAULT 0,
  output_tokens      INTEGER DEFAULT 0,
  est_cost_usd       REAL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_video_reviews_created_at ON video_reviews (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_reviews_needs_human ON video_reviews (needs_human_nurse);
