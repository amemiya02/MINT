import { useT } from "../i18n/index.ts";
import { builtinThemes } from "./catalog.ts";

export function ThemeOptions({ customThemes }: { readonly customThemes: readonly string[] }) {
  const t = useT();
  return (
    <>
      {builtinThemes.map(({ id, label }) => (
        <option key={id} value={id}>
          {t(label)}
        </option>
      ))}
      {customThemes.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </>
  );
}
