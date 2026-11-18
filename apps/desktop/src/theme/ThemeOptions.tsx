import { useT } from "../i18n/index.ts";
import { builtinThemes } from "./catalog.ts";

export function ThemeOptions({ customThemes }: { readonly customThemes: readonly string[] }) {
  const t = useT();
  return (
    <>
      <optgroup label={t("settings.theme.builtins")}>
        {builtinThemes.map(({ id, label }) => (
          <option key={id} value={id}>
            {t(label)}
          </option>
        ))}
      </optgroup>
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
