import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The Postgres tests share one database and one of them races two runs on purpose.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
