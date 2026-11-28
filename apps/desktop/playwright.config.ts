import { defineConfig, devices } from "@playwright/test";

// Override with MINT_E2E_PORT when several checkouts run E2E tests at once.
const port = Number(process.env.MINT_E2E_PORT ?? 4319);
const host = "127.0.0.1";
const serverUrl = `http://${host}:${port}`;

// Seam 3: the shell runs in a plain browser with the in-memory platform injected.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: serverUrl,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --host ${host} --port ${port} --strictPort`,
    url: serverUrl,
    reuseExistingServer: !process.env.CI,
  },
});
