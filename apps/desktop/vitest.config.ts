import { defineConfig } from "vitest/config";

// Unit tests of the shell that need no browser. E2E tests live in e2e/ and run with Playwright.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
