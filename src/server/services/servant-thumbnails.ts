import { storedServantThumbnailUrl } from "./servant-storage-config.mjs";

export function servantThumbnailUrl(
  faceId: number | null | undefined,
): string | null {
  return faceId !== null &&
    faceId !== undefined &&
    Number.isSafeInteger(faceId) &&
    faceId > 0
    ? `https://static.atlasacademy.io/JP/Faces/f_${faceId}.png`
    : null;
}

export function withServantThumbnail<
  T extends { faceId?: number | null; thumbnailPath?: string | null },
>(
  servant: T,
): Omit<T, "faceId" | "thumbnailPath"> & { thumbnailUrl: string | null } {
  const { faceId, thumbnailPath, ...details } = servant;
  const mirrored = storedServantThumbnailUrl(
    process.env.SUPABASE_URL,
    thumbnailPath,
  );
  return { ...details, thumbnailUrl: mirrored ?? servantThumbnailUrl(faceId) };
}
