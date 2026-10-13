import { Prisma } from "../../../generated/prisma";
import { downloadAtlasServantCatalogue } from "../../../scripts/lib/atlas-servant-catalogue.mjs";

// Banner imports own names/classes. Missing entries never remove saved faces.
export async function syncServantCatalogue(
  database: { $executeRaw: (query: Prisma.Sql) => PromiseLike<number> },
  dryRun: boolean,
  load = downloadAtlasServantCatalogue,
) {
  const catalogue = await load();
  if (!catalogue.size)
    throw new Error("Atlas returned an empty servant catalogue.");
  if (dryRun) return { examined: catalogue.size, updated: 0 };
  const values = [...catalogue].map(
    ([id, servant]) =>
      Prisma.sql`(${id}::integer, ${servant.rarity}::integer, ${servant.faceId}::integer)`,
  );
  const updated = await database.$executeRaw(Prisma.sql`
    UPDATE "public"."Servant" AS servant
    SET "rarity" = incoming.rarity,
        "faceId" = COALESCE(incoming.face_id, servant."faceId")
    FROM (VALUES ${Prisma.join(values)}) AS incoming(id, rarity, face_id)
    WHERE servant.id = incoming.id
      AND (servant."rarity" IS DISTINCT FROM incoming.rarity
        OR servant."faceId" IS DISTINCT FROM COALESCE(incoming.face_id, servant."faceId"))
  `);
  return { examined: catalogue.size, updated };
}
