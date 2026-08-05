-- Records which Gemini model produced each report, and adds a small config
-- table so the model can be switched from the UI without a deploy.
--
-- Why: Google stopped serving gemini-2.5-flash to this API key BEFORE its
-- published 2026-10-16 retirement date ("no longer available to new users"),
-- which broke reviews outright. Model choice therefore needs to be data, not
-- config baked into a deploy.
--
--   npx wrangler d1 migrations apply content-calendar --remote
--
-- ensureVideoReviewTables() in src/video-review.js creates both defensively at
-- runtime, so these exist whether or not this migration has run.

ALTER TABLE video_reviews ADD COLUMN model TEXT;

CREATE TABLE IF NOT EXISTS video_review_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT
);
