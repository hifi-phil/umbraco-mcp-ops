import { defineConfig } from "vitest/config";

// Real GitHub, real Worker. Scenarios run a few at a time (each has its own
// issues and PRs); more would push the driver's polling toward GitHub's
// hourly rate limit. Nothing here runs under `npm test`.
export default defineConfig({
  test: {
    include: ["driver/**/*.e2e.test.ts"],
    fileParallelism: false,
    maxConcurrency: 5,
    // Progress lines (driver/progress.ts) go straight to the terminal as they
    // happen, instead of being held and printed per test.
    disableConsoleIntercept: true,
    testTimeout: 15 * 60_000,
  },
});
