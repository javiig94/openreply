-- Historias: se publican por la misma cola que los reels.
ALTER TABLE "ScheduledPost" ADD COLUMN "mediaKind" TEXT NOT NULL DEFAULT 'REEL';
