ALTER TYPE "RewardSourceType" ADD VALUE 'MANA_PRISM_EXCHANGE';

UPDATE "RewardDefinition" AS reward
SET "expectedAt" = event."endsAt"
FROM "RewardSource" AS source
JOIN "Event" AS event ON event."id" = source."eventId"
WHERE reward."rewardSourceId" = source."id"
  AND source."type" = 'POINT_REWARD'
  AND reward."expectedAt" IS NULL
  AND event."endsAt" IS NOT NULL;
