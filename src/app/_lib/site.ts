import "server-only";

import { env } from "~/env";

const FALLBACK_SITE_URL = "https://fgo-chronicle.vercel.app";

function resolveSiteUrl() {
  if (env.SITE_URL) return new URL(env.SITE_URL);

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return new URL(
    productionHost ? `https://${productionHost}` : FALLBACK_SITE_URL,
  );
}

export const siteUrl = resolveSiteUrl();
