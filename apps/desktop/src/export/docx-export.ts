import { renderHtml } from "@mint/markdown";
import { Document, Packer } from "docx";
import { htmlToContent } from "docx/html";
import { exportImagePath } from "../assets/image-host.ts";
import type { Platform } from "../platform/platform.ts";
import { dialectOf } from "../settings/dialect.ts";
import type { Settings } from "../settings/schema.ts";

/** Convert the same Markdown dialect as the editor into editable WordprocessingML. */
export async function documentDocx(
  platform: Platform,
  path: string,
  text: string,
  settings: Settings,
) {
  const content = document.createElement("template");
  content.innerHTML = renderHtml(text, dialectOf(settings));
  const images = new Map<string, ArrayBuffer>();
  for (const image of content.content.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (images.has(src) || src.startsWith("data:image/")) continue;
    // Keep external images as links. Local images use the editor's granted asset roots.
    if (/^(?:https?:)?\/\//i.test(src)) {
      const link = document.createElement("a");
      link.href = src;
      link.textContent = image.alt || src;
      image.replaceWith(link);
      continue;
    }
    const resolved = exportImagePath(path, src);
    if (!resolved) throw new Error(src);
    images.set(src, await platform.readBinaryFile(resolved));
  }
  const children = htmlToContent(content.innerHTML, { images: (src) => images.get(src) });
  const file = new Document({ creator: "MINT", sections: [{ children }] });
  return new Uint8Array(await Packer.toArrayBuffer(file));
}
