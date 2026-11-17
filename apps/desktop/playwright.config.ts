import { defineConfig, devices } from "@playwright/test";

// Override when several checkouts run E2E tests at once.
const port = Number(process.env.MINT_E2E_PORT) || 4319;

// Seam 3: the shell runs in a plain browser with the in-memory platform injected.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
