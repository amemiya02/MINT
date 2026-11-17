import type { Page } from "@playwright/test";
import type { MemoryPlatform, MemoryPlatformOptions } from "../src/platform/memory.ts";

export {
  memoryRecoveryDir as recoveryDir,
  memorySettingsPath as settingsPath,
} from "../src/platform/memory.ts";

// Page functions are serialised into the browser, so they reach the platform through `window`.
type MintWindow = {
  __MINT_MEMORY__: MemoryPlatformOptions;
  __MINT_MEMORY_PLATFORM__: MemoryPlatform;
};

/**
 * Start the shell with an in-memory platform seeded with files, dialog answers and locale.
 * Windows opened later in the same browser context start from the same seed.
 */
export async function launch(page: Page, options: MemoryPlatformOptions = {}): Promise<void> {
  await page.context().addInitScript((seed) => {
    (window as unknown as MintWindow).__MINT_MEMORY__ = seed;
  }, options);
  await page.goto("/");
}

/** Messages of the question dialogs (e.g. "save changes?") shown so far. */
export function questionsAsked(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.questions,
  ]);
}

/** Read a file back from the in-memory platform. */
export function readFile(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.files.get(p),
    path,
  );
}

/** Every file and directory path that exists in the in-memory platform, sorted. */
export function listPaths(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.listPaths(),
  );
}

/** Paths moved to the trash, in order. */
export function trashed(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.trash]);
}

/** Read a file from MINT's app data directory. */
export function readAppData(page: Page, name: string): Promise<string | undefined> {
  return page.evaluate(
    (n) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.appData.get(n),
    name,
  );
}

/** Change a file the way another program would. */
export function externalWrite(page: Page, path: string, text: string): Promise<void> {
  return page.evaluate(
    ([p, t]) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.externalWrite(p, t),
    [path, text] as const,
  );
}

/** Delete a file or directory the way another program would. */
export function externalRemove(page: Page, path: string): Promise<void> {
  return page.evaluate(
    (p) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.externalRemove(p),
    path,
  );
}

/** URLs the shell asked the in-memory platform to open externally. */
export function openedUrls(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [
    ...(window as unknown as { __MINT_MEMORY_PLATFORM__: { openedUrls: readonly string[] } })
      .__MINT_MEMORY_PLATFORM__.openedUrls,
  ]);
}

/**
 * Change a file as another program would. Watchers are notified, so this is how
 * tests edit settings.json behind MINT's back.
 */
export async function writeFile(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ([p, t]) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.writeTextFile(p, t),
    [path, text] as const,
  );
}

/** Read a binary file (an asset such as an image) back from the in-memory platform, as bytes. */
export function readBinaryFile(page: Page, path: string): Promise<number[] | undefined> {
  return page.evaluate((p) => {
    const data = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.binaryFiles.get(p);
    return data && [...data];
  }, path);
}

/** Every file the in-memory platform holds, keyed by path (documents, settings, recovery area). */
export function files(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries((window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.files),
  );
}
