import { type MaterialRange, materialImageLimit, type NamedMaterial } from "./writing-sender.ts";

type Pdf = Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>;
export type MaterialSource =
  | { readonly kind: "pdf"; readonly file: File }
  | { readonly kind: "image"; readonly file: File };

export function rangedSource(file: File): MaterialSource | undefined {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return { kind: "pdf", file };
  if (/^image\/(png|jpe?g|webp|bmp|gif|avif)$/.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name)) {
    return { kind: "image", file };
  }
}

type LoadedSource =
  | { readonly kind: "pdf"; readonly pdf: Pdf; readonly dispose: () => Promise<void> }
  | {
      readonly kind: "image";
      readonly bitmap: ImageBitmap;
      readonly preview: string;
      readonly dispose: () => void;
    };

export async function loadMaterialSource(source: MaterialSource): Promise<LoadedSource> {
  if (source.kind === "pdf") {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(await source.file.arrayBuffer(), {
      useWasm: false,
      maxImageSize: 16_777_216,
      stopAtErrors: true,
      enableXfa: false,
    });
    return { kind: "pdf", pdf, dispose: () => pdf.loadingTask.destroy() };
  }

  const bitmap = await createImageBitmap(source.file);
  try {
    const { width, height } = bitmap;
    if (!width || !height || width * height > 32_000_000) throw new Error("materialTooLarge");
    const scale = Math.min(1, 600 / Math.max(width, height));
    const preview = canvasFor(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    preview.context.drawImage(bitmap, 0, 0, preview.canvas.width, preview.canvas.height);
    return {
      kind: "image",
      bitmap,
      preview: preview.canvas.toDataURL(),
      dispose: () => bitmap.close(),
    };
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

function canvasFor(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("invalidMaterial");
  return { canvas, context };
}

export const materialTextLimit = 2 * 1024 * 1024;

export function usableMaterialText(text: string): boolean {
  const bytes = new TextEncoder().encode(text).length;
  return bytes <= materialTextLimit && !!text.trim() && !/[^\P{Cc}\t\n\r]/u.test(text);
}

export async function prepareRangedMaterial(
  name: string,
  source: LoadedSource,
  range: MaterialRange,
  format: NonNullable<NamedMaterial["format"]>,
  caption: string,
): Promise<NamedMaterial> {
  if (format === "caption") return { name, range, format, text: caption };
  if (range.kind === "pdf" && source.kind === "pdf") {
    const page = await source.pdf.getPage(range.page);
    if (format === "extractedText") {
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      if (!usableMaterialText(text)) throw new Error("noPageText");
      return { name, range, format, text };
    }

    const { registerImageDecoders } = await import("unpdf");
    registerImageDecoders();
    const size = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / Math.max(size.width, size.height));
    const viewport = page.getViewport({ scale });
    const { canvas } = canvasFor(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return imageMaterial(name, range, canvas);
  }

  if (range.kind === "image" && source.kind === "image" && format === "image") {
    const { x, y, width, height } = range;
    const { canvas, context } = canvasFor(width, height);
    context.drawImage(source.bitmap, x, y, width, height, 0, 0, width, height);
    return imageMaterial(name, range, canvas);
  }
  throw new Error("invalidMaterial");
}

function imageMaterial(name: string, range: MaterialRange, canvas: HTMLCanvasElement): NamedMaterial {
  const image = canvas.toDataURL("image/png");
  if (!image.startsWith("data:image/png;base64,") || image.length > materialImageLimit) {
    throw new Error("materialTooLarge");
  }
  return { name, range, format: "image", text: "", image };
}

export function sourceLines(text: string) {
  // Keep line endings, including the final newline, in outbound excerpts.
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}
