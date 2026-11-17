import { createContext, useContext } from "react";
import { en } from "./en.ts";
import { zhCN } from "./zh-CN.ts";

/**
 * All UI copy goes through here. Add a key to `en.ts` first; the `Messages`
 * type then makes every other locale fail to typecheck until it is translated.
 */
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
export type Locale = "en" | "zh-CN";
export type Translate = (key: MessageKey, params?: Record<string, string>) => string;

const catalogues: Record<Locale, Messages> = { en, "zh-CN": zhCN };

/** Pick the closest supported locale for a BCP 47 tag (any Chinese variant maps to zh-CN for now). */
export function resolveLocale(tag: string): Locale {
  return tag.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** The locale for the `language` setting: a fixed locale, or the system's. */
export function localeFor(language: Locale | "system", systemTag: string): Locale {
  return language === "system" ? resolveLocale(systemTag) : language;
}

export function createTranslator(locale: Locale): Translate {
  const messages = catalogues[locale];
  return (key, params) =>
    messages[key].replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
}

export const I18nContext = createContext<Translate>(createTranslator("en"));

export function useT(): Translate {
  return useContext(I18nContext);
}
