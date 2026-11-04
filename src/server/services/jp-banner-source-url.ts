export const JP_BANNER_ORIGIN = "https://news.fate-go.jp";
export const JP_BANNER_ARTICLE_PATH_LIMIT = 240;
export function jpBannerOfficialUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== JP_BANNER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error("Unsupported JP source URL.");
  return url;
}
export function jpBannerArticleUrl(value: string) {
  const url = jpBannerOfficialUrl(value);
  if (
    !/^\/(?:20\d{2}\/(?:(?:0[1-9]|1[0-2])\/)?|info\/)[A-Za-z0-9_-]+\/(?:index\.html)?$/.test(
      url.pathname,
    ) ||
    url.pathname.length > JP_BANNER_ARTICLE_PATH_LIMIT
  )
    throw new Error("Unsupported JP article URL.");
  return url.href;
}
/** Canonical dated notice URLs only; generic info links cannot own a pickup. */
export function isJpBannerPickupUrl(value: string) {
  try {
    return (
      !value.includes("?") &&
      !value.includes("#") &&
      jpBannerArticleUrl(value) === value &&
      /^\/20\d{2}\//u.test(new URL(value).pathname)
    );
  } catch {
    return false;
  }
}
