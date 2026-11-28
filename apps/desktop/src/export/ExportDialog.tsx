import { useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useSettings } from "../settings/useSettings.ts";
import { findBuiltinTheme } from "../theme/catalog.ts";
import { ThemeOptions } from "../theme/ThemeOptions.tsx";
import { useTheme } from "../theme/useTheme.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { documentHtml, type HtmlExportChoice } from "./html-export.ts";

/** What a document exports to: an HTML file, or a PDF through the print dialog. */
export type ExportFormat = "html" | "pdf";

interface ExportDialogProps {
  readonly platform: Platform;
  readonly initialFormat: ExportFormat | undefined;
  /** The document to export. */
  readonly path: string;
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
 * Export a document: pick the theme and appearance, then either save a single
 * HTML file (optionally embedding images) or print it, to save as a PDF.
 */
export function ExportDialog({
  platform,
  initialFormat,
  path,
  getText,
  onClose,
}: ExportDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const { folder, themes } = useTheme();
  const { close, props: dialogProps } = useModalDialog(onClose);
  const titleId = useId();
  const formatId = useId();
  const [format, setFormat] = useState<ExportFormat>(initialFormat ?? "html");
  const themeId = useId();
  const appearanceId = useId();
  const imagesId = useId();
  const [appearances, setAppearances] = useState<
    Record<ExportFormat, HtmlExportChoice["appearance"]>
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
  const choice = { ...options, appearance: appearances[format] };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = stem(path);
      if (format === "pdf") {
        const html = await documentHtml(
          { platform, path, text: getText(), settings, themeFolder: folder, title: name },
          { ...choice, embedImages: true },
        );
        await platform.printDocument(html, { title: name });
        close();
        return;
      }
      const target = await platform.showSaveDialog({
        title: t("export.html.saveTitle"),
        defaultPath: `${path.slice(0, path.length - baseName(path).length)}${name}.html`,
        filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      });
      if (target) {
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
                onChange={(event) => setFormat(event.target.value === "pdf" ? "pdf" : "html")}
              >
                <option value="html">HTML</option>
                <option value="pdf">PDF</option>
              </select>
            </div>
          )}
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
          {format === "pdf" && <p className="text-(--mint-muted)">{t("export.pdf.hint")}</p>}
          {error && (
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
          <button
            type="submit"
            disabled={busy}
            className={`${buttonClass} border-(--mint-accent) font-medium`}
          >
            {t(
              busy
                ? "export.html.exporting"
                : format === "pdf"
                  ? "export.pdf.print"
                  : "export.html.export",
            )}
          </button>
        </div>
      </form>
    </dialog>
  );
}
