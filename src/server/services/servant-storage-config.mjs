import { isServantThumbnailPath } from "../../shared/servant-assets-config.mjs";

export const servantThumbnailBucket = "servant-thumbnails";
export const servantThumbnailPublicPath =
  `/storage/v1/object/public/${servantThumbnailBucket}`;

/** @param {string | undefined} value */
export function servantStorageOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Storage URL must be an approved project HTTPS origin.");
  }
  return url.origin;
}

/**
 * @param {string | undefined} projectUrl
 * @param {string | null | undefined} path
 */
export function storedServantThumbnailUrl(projectUrl, path) {
  const origin = servantStorageOrigin(projectUrl);
  return origin && isServantThumbnailPath(path)
    ? `${origin}${servantThumbnailPublicPath}/${path}`
    : null;
}
