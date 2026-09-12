CREATE TABLE "PlannerState" (
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannerState_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "PlannerState_revision_check" CHECK ("revision" >= 1)
);

ALTER TABLE "PlannerState"
ADD CONSTRAINT "PlannerState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
