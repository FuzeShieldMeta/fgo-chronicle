export const servantAssets = {
  concurrency: 4,
  timeoutMs: 15_000,
  maxBytes: 1024 * 1024,
  maxDimension: 1024,
  cacheSeconds: 365 * 24 * 60 * 60,
};

/** @param {string | null | undefined} path */
export function isServantThumbnailPath(path) {
  return (
    typeof path === "string" &&
    /^faces\/[1-9]\d*\/[a-f0-9]{64}\.png$/.test(path)
  );
}
