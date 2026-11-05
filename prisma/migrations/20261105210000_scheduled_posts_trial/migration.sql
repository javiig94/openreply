-- Trial reels: si tiene valor, el reel solo se ensena a quien no sigue la cuenta.
ALTER TABLE "ScheduledPost" ADD COLUMN "trialGraduation" TEXT;
