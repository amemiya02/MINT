import type { Translate } from "../i18n/index.ts";
import type { NamedMaterial } from "./writing-sender.ts";

export function materialLabel(material: NamedMaterial, t: Translate): string {
  if (!material.range || !material.format) return material.name;
  const range = material.range;
  const description =
    range.kind === "pdf"
      ? t("materials.pageRange", { page: String(range.page), pages: String(range.pages) })
      : t("materials.imageRange", {
          x: String(range.x),
          y: String(range.y),
          width: String(range.width),
          height: String(range.height),
        });
  return t("materials.sentRange", {
    name: material.name,
    range: description,
    format: t(`materials.format.${material.format}`),
  });
}
