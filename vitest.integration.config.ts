import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

const disposableDatabase =
  "postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa";
if (process.env.CURATOR_QA_DATABASE_URL !== disposableDatabase)
  throw new Error(
    "Set CURATOR_QA_DATABASE_URL to the documented disposable local database before running integration tests. Application DATABASE_URL is never used.",
  );

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "tests/event-import/banner-import-database.test.ts",
        "tests/timeline/planner-state-database.test.ts",
      ],
      maxWorkers: 1,
    },
  }),
);
