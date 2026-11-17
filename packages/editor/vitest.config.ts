import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Property tests mount many editors; leave room for loaded CI machines.
    testTimeout: 30_000,
  },
});
