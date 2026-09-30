import { defineConfig } from "vitest/config";

// Real GitHub, real Worker: one scenario at a time, so two never race for
// the sandbox, and nothing here runs under `npm test`.
export default defineConfig({
  test: {
    include: ["driver/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 10 * 60_000,
  },
});
