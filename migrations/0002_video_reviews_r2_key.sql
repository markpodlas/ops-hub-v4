-- Adds r2_key for drag-and-dropped videos stored in R2 (bucket nitm-video-review).
-- Separate from 0001 because 0001 was already applied before the upload feature
-- existed; an applied migration must never be edited after the fact.
--
--   npx wrangler d1 migrations apply content-calendar --remote
--
-- ensureVideoReviewTables() in src/video-review.js performs the same ALTER
-- defensively at runtime, so the column appears whether or not this has run.

ALTER TABLE video_reviews ADD COLUMN r2_key TEXT;
