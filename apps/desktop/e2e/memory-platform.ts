import type { Page } from "@playwright/test";
import type { MemoryPlatform, MemoryPlatformOptions } from "../src/platform/memory.ts";

export { memorySettingsPath as settingsPath } from "../src/platform/memory.ts";

type MemoryWindow = { __MINT_MEMORY__: MemoryPlatformOptions } & {
  __MINT_MEMORY_PLATFORM__: MemoryPlatform;
};

/**
 * Start the shell with an in-memory platform seeded with files, dialog answers and locale.
 * Windows opened later in the same browser context start from the same seed.
 */
export async function launch(page: Page, options: MemoryPlatformOptions = {}): Promise<void> {
  await page.context().addInitScript((seed) => {
    (window as unknown as MemoryWindow).__MINT_MEMORY__ = seed;
  }, options);
  await page.goto("/");
}

/** Messages of the question dialogs (e.g. "save changes?") shown so far. */
export function questionsAsked(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as { __MINT_MEMORY_PLATFORM__: { questions: readonly string[] } })
      .__MINT_MEMORY_PLATFORM__.questions,
  ]);
}

/** Read a file back from the in-memory platform. */
export function readFile(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => (window as unknown as MemoryWindow).__MINT_MEMORY_PLATFORM__.files.get(p),
    path,
  );
}

/**
 * Change a file as another program would. Watchers are notified, so this is how
 * tests edit settings.json behind MINT's back.
 */
export async function writeFile(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ([p, t]) => (window as unknown as MemoryWindow).__MINT_MEMORY_PLATFORM__.writeTextFile(p, t),
    [path, text] as const,
  );
}
