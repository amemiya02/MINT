import { useEffect, useId, useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import {
  codecFor,
  exportFormats,
  isPluginFormat,
  type PluginFormat,
} from "../plugins/export-formats.ts";
import { activeExportFormats } from "../plugins/host.ts";
import { NotionImport } from "../plugins/NotionImport.tsx";
import { pluginName, useInstallations } from "../plugins/Plugins.tsx";
import type { PageLayout, PreviewWindow } from "../print/preview.ts";
import { dialectOf } from "../settings/dialect.ts";
import { useSettings } from "../settings/useSettings.ts";
import { findBuiltinTheme } from "../theme/catalog.ts";
import { ThemeOptions } from "../theme/ThemeOptions.tsx";
import { useTheme } from "../theme/useTheme.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { documentHtml, type HtmlExportChoice } from "./html-export.ts";

export type ExportFormat = "html" | "pdf" | "docx" | PluginFormat;

interface ExportDialogProps {
  readonly platform: Platform;
  readonly initialFormat: ExportFormat | undefined;
  /** The document to export. */
  readonly path: string | null;
  readonly onOpenFolder: (path: string) => Promise<void>;
  /** Its current text, unsaved edits included. */
  readonly getText: () => string;
  readonly onClose: () => void;
}

const fieldClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const buttonClass =
  "rounded-md border border-(--mint-border) px-3 py-1 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

/** The document's name without its Markdown extension. */
function stem(path: string): string {
  return baseName(path).replace(/\.(md|markdown|mdown|mkd|txt)$/i, "");
}

/**
 * Export the current document as editable Word content, styled HTML or a printed PDF.
 */
export function ExportDialog({
  platform,
  initialFormat,
  path,
  getText,
  onOpenFolder,
  onClose,
}: ExportDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const { folder, themes } = useTheme();
  const { close, props: dialogProps } = useModalDialog(onClose);
  const titleId = useId();
  const formatId = useId();
  const installations = useInstallations();
  const formats = activeExportFormats(installations);
  const importers = installations.filter((i) => i.enabled && "importer" in i.manifest);
  const [selectedFormat, setFormat] = useState<string>(
    initialFormat ?? (path ? "html" : `import:${importers[0]?.manifest.id ?? ""}`),
  );
  const removed =
    selectedFormat.startsWith("import:") &&
    !importers.some(({ manifest }) => `import:${manifest.id}` === selectedFormat);
  const format = removed && path ? "html" : selectedFormat;
  const importing = format.startsWith("import:");
  const themeId = useId();
  const appearanceId = useId();
  const imagesId = useId();
  const [appearances, setAppearances] = useState<
    Record<"html" | "pdf", HtmlExportChoice["appearance"]>
  >(() => ({
    html: document.documentElement.dataset.appearance === "dark" ? "dark" : "light",
    pdf: "light",
  }));
  const [options, setOptions] = useState(() => ({
    // The look on screen: the theme in use and the current appearance.
    theme:
      findBuiltinTheme(settings.theme)?.id ??
      (themes.includes(settings.theme) ? settings.theme : ""),
    // The print window has no folder to resolve images against: PDFs always embed them.
    embedImages: true,
  }));
  const choice = { ...options, appearance: appearances[format === "pdf" ? "pdf" : "html"] };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy && !path && removed) close();
  }, [busy, path, removed, close]);

  const [layout, setLayout] = useState<PageLayout>({
    paper: "A4",
    margin: 16,
    font: Math.round(settings.fontSize * 0.75),
  });
  const pdfText = format === "pdf" ? getText() : null;
  const appearance = choice.appearance;
  const theme = choice.theme;
  const request = useMemo(
    () =>
      pdfText === null || !path
        ? null
        : {
            source: {
              platform,
              path,
              text: pdfText,
              settings,
              themeFolder: folder,
              title: stem(path),
            },
            choice: { appearance, theme, embedImages: true },
          },
    [pdfText, appearance, theme, platform, path, settings, folder],
  );
  const [source, setSource] = useState<{
    request: typeof request;
    html: string;
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!request) return;
    let current = true;
    setError(null);
    documentHtml(request.source, request.choice)
      .then((html) => {
        if (current)
          setSource((previous) => ({ request, html, generation: (previous?.generation ?? 0) + 1 }));
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [request]);
  const layoutKey = [source?.generation, layout.paper, layout.margin, layout.font].join("/");
  const [preview, setPreview] = useState<{ key: string; html: string; count: number } | null>(null);
  const ready = source?.request === request && preview?.key === layoutKey;

  const exportFile = async () => {
    if (!path || importing) return;
    setBusy(true);
    setError(null);
    try {
      const name = stem(path);
      if (format === "pdf") {
        if (!preview || !ready) throw new Error(t("export.pdf.preview"));
        const target = platform.savesPdfDirectly
          ? await platform.showSaveDialog({
              title: t("export.pdf.saveTitle"),
              defaultPath: `${path.slice(0, path.length - baseName(path).length)}${name}.pdf`,
              filters: [{ name: "PDF", extensions: ["pdf"] }],
            })
          : undefined;
        if (target === null) {
          close();
          return;
        }
        if (target === path) throw new Error(t("export.docx.chooseAnotherFile"));
        await platform.printDocument(preview.html, {
          title: name,
          paper: layout.paper,
          ...(target ? { target } : {}),
        });
        close();
        return;
      }
      if (isPluginFormat(format)) {
        const codec = codecFor(format);
        const target = await platform.showSaveDialog({
          title: t("export.plugin.saveTitle", { format: codec.label }),
          defaultPath: `${path.slice(0, path.length - baseName(path).length)}${name}.${codec.extension}`,
          filters: [{ name: codec.label, extensions: [codec.extension] }],
        });
        if (target) {
          if (target === path) throw new Error(t("export.docx.chooseAnotherFile"));
          const requireGrant = () => {
            if (!activeExportFormats().includes(format)) throw new Error(t("plugin.denied"));
          };
          requireGrant();
          const content = await codec.encode({
            title: name,
            text: getText(),
            dialect: dialectOf(settings),
            language: document.documentElement.lang || platform.locale,
          });
          requireGrant();
          if (typeof content === "string") await platform.writeTextFile(target, content);
          else await platform.writeBinaryFile(target, content);
        }
        close();
        return;
      }
      const word = format === "docx";
      const target = await platform.showSaveDialog({
        title: t(word ? "export.docx.saveTitle" : "export.html.saveTitle"),
        defaultPath: `${path.slice(0, path.length - baseName(path).length)}${name}.${format}`,
        filters: [
          word
            ? { name: "DOCX", extensions: ["docx"] }
            : { name: "HTML", extensions: ["html", "htm"] },
        ],
      });
      if (target && word) {
        if (target === path) throw new Error(t("export.docx.chooseAnotherFile"));
        const { documentDocx } = await import("./docx-export.ts");
        await platform.writeBinaryFile(
          target,
          await documentDocx(platform, path, getText(), settings),
        );
      } else if (target) {
        const html = await documentHtml(
          { platform, path, text: getText(), settings, themeFolder: folder, title: name },
          choice,
        );
        await platform.writeTextFile(target, html);
      }
      close();
    } catch (e) {
      setError(t("export.html.failed", { reason: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  return (
    <dialog
      {...dialogProps}
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else dialogProps.onCancel(e);
      }}
      style={format === "pdf" ? { width: "min(46rem, calc(100% - 2rem))" } : undefined}
      className="m-auto w-[min(26rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-0 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void exportFile();
        }}
      >
        <h2
          id={titleId}
          className="border-b border-(--mint-border) px-5 py-3 text-base font-medium"
        >
          {t(
            initialFormat === undefined
              ? "export.title"
              : format === "pdf"
                ? "export.pdf.title"
                : "export.html.title",
          )}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4 text-sm">
          {initialFormat === undefined && (
            <div className="flex items-center justify-between gap-4">
              <label htmlFor={formatId}>{t("export.format")}</label>
              <select
                id={formatId}
                value={format}
                disabled={busy}
                className={fieldClass}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option disabled={!path} value="html">
                  HTML
                </option>
                <option disabled={!path} value="pdf">
                  PDF
                </option>
                <option disabled={!path} value="docx">
                  DOCX
                </option>
                {isPluginFormat(format) && !formats.includes(format) && (
                  <option value={format} disabled>
                    {t("export.plugin.unavailable")}
                  </option>
                )}
                {formats.map((key) => (
                  <option disabled={!path} key={key} value={key}>
                    {exportFormats[key].label}
                  </option>
                ))}
                {importers.map(({ manifest }) => (
                  <option key={manifest.id} value={`import:${manifest.id}`}>
                    {pluginName(manifest, t)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {importing && (
            <NotionImport
              key={format}
              id={format.slice(7)}
              platform={platform}
              busy={busy}
              setBusy={setBusy}
              onOpenFolder={async (folder) => {
                await onOpenFolder(folder);
                close();
              }}
            />
          )}
          {(format === "html" || format === "pdf") && (
            <>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={themeId}>{t("settings.theme")}</label>
                <select
                  id={themeId}
                  value={choice.theme}
                  onChange={(e) => setOptions({ ...options, theme: e.target.value })}
                  className={fieldClass}
                >
                  <ThemeOptions customThemes={themes} />
                </select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={appearanceId}>{t("settings.appearance")}</label>
                <select
                  id={appearanceId}
                  value={choice.appearance}
                  onChange={(e) =>
                    setAppearances({
                      ...appearances,
                      [format]: e.target.value === "dark" ? "dark" : "light",
                    })
                  }
                  className={fieldClass}
                >
                  <option value="light">{t("settings.appearance.light")}</option>
                  <option value="dark">{t("settings.appearance.dark")}</option>
                </select>
              </div>
            </>
          )}
          {format === "html" && (
            <div className="flex items-center justify-between gap-4">
              <label htmlFor={imagesId}>{t("export.html.embedImages")}</label>
              <input
                id={imagesId}
                type="checkbox"
                checked={choice.embedImages}
                onChange={(e) => setOptions({ ...options, embedImages: e.target.checked })}
                className="size-4 accent-(--mint-accent)"
              />
            </div>
          )}
          {format === "pdf" && (
            <>
              <div className="flex flex-wrap gap-3">
                <label>
                  {t("export.pdf.paper")}{" "}
                  <select
                    className={fieldClass}
                    value={layout.paper}
                    onChange={(event) =>
                      setLayout({ ...layout, paper: event.target.value as PageLayout["paper"] })
                    }
                  >
                    {["A4", "A5", "Letter"].map((size) => (
                      <option key={size}>{size}</option>
                    ))}
                  </select>
                </label>
                {(["margin", "font"] as const).map((key) => (
                  <label key={key}>
                    {t(key === "margin" ? "export.pdf.margins" : "export.pdf.font")}{" "}
                    <input
                      type="number"
                      className={`${fieldClass} w-16`}
                      value={Number.isFinite(layout[key]) ? layout[key] : ""}
                      min={key === "margin" ? 0 : 6}
                      max={key === "margin" ? 50 : 48}
                      onChange={(event) =>
                        setLayout({ ...layout, [key]: event.target.valueAsNumber })
                      }
                    />
                  </label>
                ))}
              </div>
              {source &&
                source.request === request &&
                Number.isFinite(layout.margin) &&
                layout.margin >= 0 &&
                layout.margin <= 50 &&
                layout.font >= 6 &&
                layout.font <= 48 && (
                  <iframe
                    key={layoutKey}
                    title={t("export.pdf.preview")}
                    src="/pdf-preview.html"
                    className="h-[36vh] w-full rounded-md border border-(--mint-border)"
                    onLoad={async (event) => {
                      const frame = event.currentTarget;
                      try {
                        const result = await (frame.contentWindow as PreviewWindow).paginate(
                          source.html,
                          layout,
                        );
                        if (frame.isConnected) setPreview({ ...result, key: layoutKey });
                      } catch (reason) {
                        if (frame.isConnected) setError(String(reason));
                      }
                    }}
                  />
                )}
              {ready && <output>{t("export.pdf.pages", { count: String(preview.count) })}</output>}
              {!platform.savesPdfDirectly && (
                <p className="text-(--mint-muted)">{t("export.pdf.hint")}</p>
              )}
            </>
          )}
          {error && !importing && (
            <p
              role="alert"
              className="rounded-md bg-(--mint-error-bg) px-3 py-2 text-(--mint-error-fg)"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-(--mint-border) px-5 py-3">
          <button type="button" disabled={busy} onClick={close} className={buttonClass}>
            {t("export.html.cancel")}
          </button>
          {!importing && (
            <button
              type="submit"
              disabled={
                busy ||
                (isPluginFormat(format) && !formats.includes(format)) ||
                (format === "pdf" && !ready)
              }
              className={`${buttonClass} border-(--mint-accent) font-medium`}
            >
              {t(
                busy
                  ? "export.html.exporting"
                  : format === "pdf"
                    ? platform.savesPdfDirectly
                      ? "export.pdf.save"
                      : "export.pdf.print"
                    : "export.html.export",
              )}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
