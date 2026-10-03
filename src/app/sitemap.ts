import type { MetadataRoute } from "next";

import { siteUrl } from "~/app/_lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", siteUrl).toString(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: new URL("/methodology", siteUrl).toString(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];
}
