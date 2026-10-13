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

export function withServantThumbnail<T extends { faceId?: number | null }>(
  servant: T,
): Omit<T, "faceId"> & { thumbnailUrl: string | null } {
  const { faceId, ...details } = servant;
  return { ...details, thumbnailUrl: servantThumbnailUrl(faceId) };
}
