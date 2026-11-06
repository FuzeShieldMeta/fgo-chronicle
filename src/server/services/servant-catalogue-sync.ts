import { Prisma } from "../../../generated/prisma";
import { downloadAtlasServantCatalogues } from "../../../scripts/lib/atlas-servant-catalogue.mjs";

// A resolved NA flag (including false) identifies catalogue-backed metadata to banner imports.
export async function syncServantCatalogue(
  database: { $executeRaw: (query: Prisma.Sql) => PromiseLike<number> },
  dryRun: boolean,
  load = downloadAtlasServantCatalogues,
) {
  const catalogue = await load();
  if (!catalogue.size)
    throw new Error("Atlas returned an empty servant catalogue.");
  if (dryRun) return { examined: catalogue.size, updated: 0 };
  const values = [...catalogue]
    .sort(([a], [b]) => a - b)
    .map(
      ([id, servant]) =>
        Prisma.sql`(${id}::integer, ${servant.name}::text, ${servant.className}::text, ${servant.rarity}::integer, ${servant.faceId}::integer, ${servant.atlasNaAvailable}::boolean)`,
    );
  const updated = await database.$executeRaw(Prisma.sql`
    INSERT INTO "public"."Servant" AS servant ("id", "name", "className", "rarity", "faceId", "atlasNaAvailable")
    SELECT * FROM (VALUES ${Prisma.join(values)}) AS incoming(id, name, class_name, rarity, face_id, na_available)
    ORDER BY id
    ON CONFLICT ("id") DO UPDATE
    SET "name" = EXCLUDED."name",
        "className" = EXCLUDED."className",
        "rarity" = EXCLUDED."rarity",
        "faceId" = COALESCE(EXCLUDED."faceId", servant."faceId"),
        "atlasNaAvailable" = EXCLUDED."atlasNaAvailable"
    WHERE (servant."name", servant."className", servant."rarity", servant."faceId", servant."atlasNaAvailable")
      IS DISTINCT FROM (EXCLUDED."name", EXCLUDED."className", EXCLUDED."rarity", COALESCE(EXCLUDED."faceId", servant."faceId"), EXCLUDED."atlasNaAvailable")
  `);
  return { examined: catalogue.size, updated };
}
