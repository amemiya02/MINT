import { builtinThemes } from "./catalog.ts";

export function ThemeOptions({ customThemes }: { readonly customThemes: readonly string[] }) {
  return (
    <>
      {builtinThemes.map(({ id, label }) => (
        <option key={id} value={id}>
          {label}
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
