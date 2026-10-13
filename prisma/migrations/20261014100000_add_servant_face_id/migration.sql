ALTER TABLE "Servant" ADD COLUMN "faceId" INTEGER;
ALTER TABLE "Servant" ADD CONSTRAINT "Servant_faceId_positive"
  CHECK ("faceId" IS NULL OR "faceId" > 0);
