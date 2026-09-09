import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "src"),
    },
  },
  ssr: {
    noExternal: ["next-auth"],
  },
  test: {
    environment: "node",
    env: {
      AUTH_GOOGLE_ID: "test-google-client",
      AUTH_GOOGLE_SECRET: "test-google-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/fgo_chronicle_test",
      NODE_ENV: "test",
    },
  },
});
