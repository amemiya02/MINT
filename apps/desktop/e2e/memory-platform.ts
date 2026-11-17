import type { Page } from "@playwright/test";
import type { MemoryPlatformOptions } from "../src/platform/memory.ts";

/** Start the shell with an in-memory platform seeded with files, dialog answers and locale. */
export async function launch(page: Page, options: MemoryPlatformOptions): Promise<void> {
  await page.addInitScript((seed) => {
    (window as unknown as { __MINT_MEMORY__: MemoryPlatformOptions }).__MINT_MEMORY__ = seed;
  }, options);
  await page.goto("/");
}

/** Read a file back from the in-memory platform. */
export function readFile(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(
    (p) =>
      (
        window as unknown as { __MINT_MEMORY_PLATFORM__: { files: Map<string, string> } }
      ).__MINT_MEMORY_PLATFORM__.files.get(p),
    path,
  );
}
