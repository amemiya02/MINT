import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createTranslator, I18nContext, resolveLocale } from "./i18n/index.ts";
import { createMemoryPlatform, type MemoryPlatformOptions } from "./platform/memory.ts";
import type { Platform } from "./platform/platform.ts";
import { createTauriPlatform, isTauri } from "./platform/tauri.ts";
import "./styles.css";

declare global {
  interface Window {
    /** Seed for the in-memory platform (set by E2E tests before the page loads). */
    __MINT_MEMORY__?: MemoryPlatformOptions;
    /** The in-memory platform instance, exposed for E2E assertions. */
    __MINT_MEMORY_PLATFORM__?: Platform;
  }
}

function choosePlatform(): Platform {
  if (isTauri()) return createTauriPlatform();
  const platform = createMemoryPlatform(window.__MINT_MEMORY__);
  window.__MINT_MEMORY_PLATFORM__ = platform;
  return platform;
}

const platform = choosePlatform();
const locale = resolveLocale(platform.locale);
document.documentElement.lang = locale;

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <I18nContext value={createTranslator(locale)}>
      <App platform={platform} />
    </I18nContext>
  </StrictMode>,
);
