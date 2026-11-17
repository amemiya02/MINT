import { renderMermaid } from "@mint/editor";
import { defaultDialect, type ExportImage, exportHtml } from "@mint/markdown";
import { createImageHost } from "../assets/image-host.ts";
import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";
import builtinThemeCss from "../theme/builtin.css?raw";
import { readUserTheme, typographyCss } from "../theme/theme.ts";

/** What the user chose in the export dialog. */
export interface HtmlExportChoice {
  /** A user theme's name, or `""` for the built-in theme. */
  readonly theme: string;
  readonly appearance: "light" | "dark";
  /** Embed local images as data URIs instead of linking to them. */
  readonly embedImages: boolean;
}

export interface HtmlExportSource {
  readonly platform: Platform;
  /** The document's path: local images resolve against it. */
  readonly path: string;
  readonly text: string;
  readonly settings: Settings;
  /** The theme folder (see `ThemeState.folder`). */
  readonly themeFolder: string;
  /** The `<title>` if the document has no heading: its name. */
  readonly title: string;
}

/**
 * The standalone HTML of a document, styled like the editor shows it in the
 * chosen theme: the built-in themes, then the user theme, then the font
 * settings, as on screen. Mermaid diagrams are rendered as in the editor.
 * HTML export saves it; PDF export prints it.
 */
export async function documentHtml(source: HtmlExportSource, choice: HtmlExportChoice) {
  const { platform, settings } = source;
  const userTheme =
    choice.theme === "" ? "" : await readUserTheme(platform, source.themeFolder, choice.theme);
  // Only resolving images: export never saves one.
  const images = createImageHost(
    platform,
    () => source.path,
    () => settings,
    () => {},
  );
  return exportHtml(source.text, {
    dialect: defaultDialect,
    title: source.title,
    themeCss: [builtinThemeCss, userTheme, typographyCss(settings)].join("\n"),
    appearance: choice.appearance,
    renderMermaid,
    ...(choice.embedImages
      ? { loadImage: (src: string) => loadImage(src, images.resolveImageUrl) }
      : {}),
  });
}

/** A local image's bytes; `null` for remote images (http:, https:...), which stay links. */
async function loadImage(
  src: string,
  resolve: (path: string) => string | null,
): Promise<ExportImage | null> {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1]?.toLowerCase();
  // A one-letter "scheme" is a Windows drive.
  if (scheme && scheme !== "file" && scheme.length > 1) return null;
  // Resolved exactly as the editor resolves the images it shows.
  const url = resolve(src);
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  const type = blob.type.startsWith("image/") ? blob.type : imageType(src);
  return { data: new Uint8Array(await blob.arrayBuffer()), type };
}

const imageTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

function imageType(src: string): string {
  const extension = /\.(\w+)(?:[?#].*)?$/.exec(src)?.[1]?.toLowerCase() ?? "";
  return imageTypes[extension] ?? "application/octet-stream";
}
