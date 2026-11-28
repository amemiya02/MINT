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

export type PluginFormat = keyof typeof exportFormats;

export function isPluginFormat(value: unknown): value is PluginFormat {
  return typeof value === "string" && Object.hasOwn(exportFormats, value);
}

export function codecFor(format: PluginFormat): FormatCodec {
  return exportFormats[format];
}
