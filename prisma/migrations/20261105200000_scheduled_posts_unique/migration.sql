-- El mismo reel no puede estar activo o publicado dos veces en una cuenta.
-- Prisma no sabe expresar indices parciales: esta en SQL a proposito.
CREATE UNIQUE INDEX "ScheduledPost_active_video_key"
  ON "ScheduledPost" ("instagramAccountId", "videoFile")
  WHERE "status" IN ('SCHEDULED', 'PROCESSING', 'PUBLISHING', 'PUBLISHED', 'UNCONFIRMED');
