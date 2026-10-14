/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";
import {
  servantThumbnailPublicPath,
  servantStorageOrigin,
} from "./src/server/services/servant-storage-config.mjs";
const storageOrigin = servantStorageOrigin(process.env.SUPABASE_URL);

/** @type {import("next").NextConfig} */
const config = {
  outputFileTracingRoot: process.cwd(),
  images: {
    remotePatterns: [
      ...(storageOrigin
        ? [
            {
              protocol: /** @type {const} */ ("https"),
              hostname: new URL(storageOrigin).hostname,
              port: "",
              pathname: `${servantThumbnailPublicPath}/faces/**`,
              search: "",
            },
          ]
        : []),
      {
        protocol: "https",
        hostname: "static.atlasacademy.io",
        port: "",
        pathname: "/JP/Faces/f_*.png",
        search: "",
      },
      {
        protocol: "https",
        hostname: "static.atlasacademy.io",
        port: "",
        pathname: "/JP/Banner/**",
        search: "",
      },
      {
        protocol: "https",
        hostname: "static.atlasacademy.io",
        port: "",
        pathname: "/NA/Banner/**",
        search: "",
      },
      {
        protocol: "https",
        hostname: "static.atlasacademy.io",
        port: "",
        pathname: "/NA/Items/**",
        search: "",
      },
    ],
  },
};

export default config;
