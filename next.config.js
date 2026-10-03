/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  outputFileTracingRoot: process.cwd(),
  images: {
    remotePatterns: [
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
