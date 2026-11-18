import { useT } from "../i18n/index.ts";
import { themeGroups } from "./catalog.ts";

export function ThemeOptions({ customThemes }: { readonly customThemes: readonly string[] }) {
  const t = useT();
  return (
    <>
      {themeGroups.map((group) => (
        <optgroup key={group.label} label={t(group.label)}>
          {group.themes.map(({ id, label }) => (
            <option key={id} value={id}>
              {t(label)}
            </option>
          ))}
        </optgroup>
      ))}
      {customThemes.length > 0 && (
        <optgroup label={t("settings.theme.custom")}>
          {customThemes.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}
