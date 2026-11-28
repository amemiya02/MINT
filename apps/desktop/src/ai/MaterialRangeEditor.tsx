import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import {
  loadMaterialSource,
  type MaterialSource,
  prepareRangedMaterial,
  usableMaterialText,
} from "./material-source.ts";
import type { ImageRegion, MaterialRange, NamedMaterial } from "./writing-sender.ts";

const button =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 disabled:opacity-50";
const field = "rounded border border-(--mint-border) bg-(--mint-bg) p-1";
type Coordinate = keyof ImageRegion;
const coordinates = ["x", "y", "width", "height"] as const;

function initialRegion(previous?: MaterialRange): Partial<Record<Coordinate, string>> {
  return previous?.kind === "image"
    ? {
        x: String(previous.x),
        y: String(previous.y),
        width: String(previous.width),
        height: String(previous.height),
      }
    : { x: "0", y: "0" };
}

export function MaterialRangeEditor({
  source,
  previous,
  vision,
  onAccept,
  onRemove,
}: {
  readonly source: MaterialSource;
  readonly previous?: NamedMaterial;
  readonly vision: boolean;
  readonly onAccept: (material: NamedMaterial) => void;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadMaterialSource>> | null>(null);
  const [page, setPage] = useState(
    previous?.range?.kind === "pdf" ? String(previous.range.page) : "1",
  );
  const [region, setRegion] = useState(() => initialRegion(previous?.range));
  const fallback = source.kind === "pdf" ? "extractedText" : "caption";
  const [requestedFormat, setFormat] = useState(previous?.format ?? fallback);
  const format =
    requestedFormat === "summary" || (requestedFormat === "image" && !vision)
      ? fallback
      : requestedFormat;
  const [caption, setCaption] = useState(previous?.format === "caption" ? previous.text : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalidRange" | "noPageText" | "materialTooLarge" | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    const reading = loadMaterialSource(source);
    void reading.then(
      (result) => {
        if (current) setLoaded(result);
      },
      () => {
        if (current) setError("invalidRange");
      },
    );
    return () => {
      current = false;
      void reading.then((result) => result.dispose()).catch(() => {});
    };
  }, [source]);

  const bitmap = loaded?.kind === "image" ? loaded.bitmap : undefined;
  const value = {
    x: region.x ?? "",
    y: region.y ?? "",
    width: region.width ?? String(bitmap?.width ?? ""),
    height: region.height ?? String(bitmap?.height ?? ""),
  };
  const rect = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  const validRect =
    bitmap &&
    coordinates.every((key) => value[key] !== "" && Number.isInteger(rect[key])) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= 1 &&
    rect.height >= 1 &&
    rect.x + rect.width <= bitmap.width &&
    rect.y + rect.height <= bitmap.height;
  const pageNumber = Number(page);
  let range: MaterialRange | undefined;
  if (
    loaded?.kind === "pdf" &&
    Number.isInteger(pageNumber) &&
    pageNumber >= 1 &&
    pageNumber <= loaded.pdf.numPages
  ) {
    range = { kind: "pdf", page: pageNumber, pages: loaded.pdf.numPages };
  } else if (validRect) {
    range = { kind: "image", ...rect };
  }
  const canAccept = range && (format !== "caption" || usableMaterialText(caption));

  async function accept() {
    if (!loaded || !range || !canAccept || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAccept(await prepareRangedMaterial(source.file.name, loaded, range, format, caption));
    } catch (problem) {
      const code = problem instanceof Error ? problem.message : "";
      setError(code === "noPageText" || code === "materialTooLarge" ? code : "invalidRange");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset disabled={busy} className="space-y-2 rounded border border-(--mint-border) p-2">
      <legend className="px-1 wrap-anywhere">{source.file.name}</legend>
      {!loaded && !error && <p role="status">{t("materials.reading")}</p>}
      {loaded?.kind === "pdf" && (
        <label className="flex flex-wrap items-center gap-2">
          {t("materials.pdfPage")}
          <input
            className={`w-20 ${field}`}
            type="number"
            min={1}
            max={loaded.pdf.numPages}
            value={page}
            onChange={(event) => setPage(event.target.value)}
          />
          <span aria-hidden="true">/ {loaded.pdf.numPages}</span>
        </label>
      )}
      {loaded?.kind === "image" && bitmap && (
        <>
          <div className="relative mx-auto w-fit max-w-full">
            <img
              className="block h-auto max-w-full"
              src={loaded.preview}
              alt={t("materials.sourcePreview")}
            />
            {validRect && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_1px_black]"
                style={{
                  left: `${(rect.x / bitmap.width) * 100}%`,
                  top: `${(rect.y / bitmap.height) * 100}%`,
                  width: `${(rect.width / bitmap.width) * 100}%`,
                  height: `${(rect.height / bitmap.height) * 100}%`,
                }}
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {coordinates.map((key) => (
              <label key={key} className="grid gap-1">
                {t(`materials.coordinate.${key}`)}
                <input
                  className={`w-full ${field}`}
                  type="number"
                  min={key === "x" || key === "y" ? 0 : 1}
                  value={value[key]}
                  onChange={(event) => {
                    const number = event.target.value;
                    setRegion((previous) => ({ ...previous, [key]: number }));
                  }}
                />
              </label>
            ))}
          </div>
          {!validRect && <p>{t("materials.regionBounds")}</p>}
        </>
      )}
      {loaded && (
        <>
          <label className="flex flex-wrap items-center gap-2">
            {t("materials.sendAs")}
            <select
              className={field}
              value={format}
              onChange={(event) => {
                const next = event.target.value as typeof format;
                setFormat(next);
                setError(null);
              }}
            >
              {source.kind === "pdf" && (
                <option value="extractedText">{t("materials.format.extractedText")}</option>
              )}
              <option value="caption">{t("materials.format.caption")}</option>
              <option value="image" disabled={!vision}>
                {t("materials.format.image")}
              </option>
            </select>
          </label>
          {format === "caption" && (
            <label className="grid gap-1">
              {t("materials.format.caption")}
              <textarea
                className={field}
                rows={2}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
              />
            </label>
          )}
        </>
      )}
      {error && <p role="alert">{t(`materials.${error}`)}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          type="button"
          disabled={!canAccept || busy}
          onClick={() => void accept()}
        >
          {t("materials.useRange")}
        </button>
        <button className={button} type="button" onClick={onRemove}>
          {t("materials.remove", { name: source.file.name })}
        </button>
      </div>
    </fieldset>
  );
}
