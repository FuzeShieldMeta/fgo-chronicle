CREATE TABLE "StoryChapter" (
    "warId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "lastQuestId" INTEGER NOT NULL,
    "optional" BOOLEAN NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "StoryChapter_pkey" PRIMARY KEY ("warId")
);
CREATE UNIQUE INDEX "StoryChapter_lastQuestId_key" ON "StoryChapter"("lastQuestId");
