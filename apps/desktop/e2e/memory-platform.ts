import type { Page } from "@playwright/test";
import type { MemoryPlatform, MemoryPlatformOptions } from "../src/platform/memory.ts";

export {
  memoryRecoveryDir as recoveryDir,
  memorySettingsPath as settingsPath,
  memoryThemesPath as themesPath,
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

/** Rename or move a file or directory the way another program would. */
export function externalRename(page: Page, from: string, to: string): Promise<void> {
  return page.evaluate(
    ([f, t]) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.externalRename(f, t),
    [from, to] as const,
  );
}

export interface MenuSnapshot {
  readonly label: string;
  readonly items: readonly { id: string; label: string; accelerator: string | null }[];
}

/** The application menu the shell installed: its command items, per submenu. */
export function menu(page: Page): Promise<MenuSnapshot[]> {
  return page.evaluate(() =>
    (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.menu.map((m) => ({
      label: m.label,
      items: m.items.flatMap((i) =>
        i.kind === "command"
          ? [{ id: i.id, label: i.label, accelerator: i.accelerator ?? null }]
          : [],
      ),
    })),
  );
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

/** Activate a native menu item by its command id, as a click in the menu bar would. */
export async function runMenuItem(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (menuId) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.runMenuItem(menuId),
    id,
  );
}

/** Versions MINT has installed (and restarted into) so far. */
export function updatesInstalled(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.updatesInstalled,
  ]);
}

/** The paths each save dialog suggested so far, in order. */
export function savedDialogs(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.saveDialogs,
  ]);
}

/** Hand documents or folders to MINT from outside, as a double-click in the file manager would. */
export async function openFromOutside(
  page: Page,
  paths: readonly { path: string; kind: "file" | "directory" }[],
): Promise<void> {
  await page.evaluate(
    (p) => (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.openFromOutside(p),
    paths,
  );
}

/** The documents sent to the printer so far, in order. */
export function printedDocuments(page: Page): Promise<{ html: string; title: string }[]> {
  return page.evaluate(() => [
    ...(window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.printed,
  ]);
}
