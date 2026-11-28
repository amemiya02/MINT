import type { Dialect } from "@mint/markdown";

/** Codecs receive only the granted draft, never a platform or filesystem handle. */
export interface ExportSource {
  title: string;
  text: string;
  dialect: Dialect;
  language: string;
}

interface FormatCodec {
  label: string;
  extension: string;
  encode(source: ExportSource): Promise<string | Uint8Array>;
}

export const exportFormats = {
  latex: {
    label: "LaTeX",
    extension: "tex",
    encode: async (source) => (await import("./latex.ts")).encodeLatex(source),
  },
  epub: {
    label: "EPUB",
    extension: "epub",
    encode: async (source) => (await import("./epub.ts")).encodeEpub(source),
  },
} satisfies Record<string, FormatCodec>;

interface TextFormat {
  label: string;
  extension: string;
  template: string;
}

export type PluginFormat = keyof typeof exportFormats | TextFormat;

export function isPluginFormat(value: unknown): value is PluginFormat {
  if (typeof value === "string") return Object.hasOwn(exportFormats, value);
  if (!value || typeof value !== "object") return false;
  const format = value as Partial<TextFormat>;
  return (
    typeof format.label === "string" &&
    !!format.label.trim() &&
    format.label.length <= 120 &&
    typeof format.extension === "string" &&
    /^[a-z0-9]{1,16}$/i.test(format.extension) &&
    typeof format.template === "string" &&
    /\{\{(?:json\.)?text\}\}/.test(format.template)
  );
}

export function codecFor(format: PluginFormat): FormatCodec {
  if (typeof format === "string") return exportFormats[format];
  return {
    label: format.label,
    extension: format.extension,
    async encode(source) {
      return format.template.replace(
        /\{\{(json\.)?(title|text|language)\}\}/g,
        (_, json: string | undefined, key: "title" | "text" | "language") =>
          json ? JSON.stringify(source[key]) : source[key],
      );
    },
  };
}
