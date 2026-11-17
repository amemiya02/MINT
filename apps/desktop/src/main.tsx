import { type ReactNode, StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createTranslator, I18nContext, localeFor } from "./i18n/index.ts";
import { createMemoryPlatform, type MemoryPlatformOptions } from "./platform/memory.ts";
import type { Platform } from "./platform/platform.ts";
import { createTauriPlatform, isTauri } from "./platform/tauri.ts";
import { createSettingsStore } from "./settings/settings.ts";
import { SettingsContext, useSettings } from "./settings/useSettings.ts";
import { createThemeStore } from "./theme/theme.ts";
import { ThemeContext } from "./theme/useTheme.ts";
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

/** Provides UI strings in the language chosen in settings (by default the system's). */
function Localized({ systemLocale, children }: { systemLocale: string; children: ReactNode }) {
  const { language } = useSettings().settings;
  const locale = localeFor(language, systemLocale);
  const t = useMemo(() => createTranslator(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext value={t}>{children}</I18nContext>;
}

const platform = choosePlatform();
// Loaded before the first render so the interface never flashes in the wrong language.
const settings = await createSettingsStore(platform);
// Likewise for the theme, so the first frame already has the right colors.
const theme = await createThemeStore(platform, settings);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <SettingsContext value={settings}>
      <ThemeContext value={theme}>
        <Localized systemLocale={platform.locale}>
          <App platform={platform} />
        </Localized>
      </ThemeContext>
    </SettingsContext>
  </StrictMode>,
);
