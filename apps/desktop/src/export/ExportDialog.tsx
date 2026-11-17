import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useSettings } from "../settings/useSettings.ts";
import { baseName } from "../tabs/paths.ts";
import { useTheme } from "../theme/useTheme.ts";
import { documentHtml, type HtmlExportChoice } from "./html-export.ts";

/** What a document exports to: an HTML file, or a PDF through the print dialog. */
export type ExportFormat = "html" | "pdf";

interface ExportDialogProps {
  readonly platform: Platform;
  readonly format: ExportFormat;
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
export function ExportDialog({ platform, format, path, getText, onClose }: ExportDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const { folder, themes } = useTheme();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const themeId = useId();
  const appearanceId = useId();
  const imagesId = useId();
  const [choice, setChoice] = useState<HtmlExportChoice>(() => ({
    // The look on screen: the theme in use and the current appearance.
    theme: themes.includes(settings.theme) ? settings.theme : "",
    // Paper is light; HTML keeps the current appearance.
    appearance:
      format === "html" && document.documentElement.dataset.appearance === "dark"
        ? "dark"
        : "light",
    // The print window has no folder to resolve images against: PDFs always embed them.
    embedImages: true,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

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
        dialog.current?.close();
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
      dialog.current?.close();
    } catch (e) {
      setError(t("export.html.failed", { reason: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
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
          {t(format === "pdf" ? "export.pdf.title" : "export.html.title")}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={themeId}>{t("settings.theme")}</label>
            <select
              id={themeId}
              value={choice.theme}
              onChange={(e) => setChoice({ ...choice, theme: e.target.value })}
              className={fieldClass}
            >
              <option value="">{t("settings.theme.builtin")}</option>
              {themes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={appearanceId}>{t("settings.appearance")}</label>
            <select
              id={appearanceId}
              value={choice.appearance}
              onChange={(e) =>
                setChoice({ ...choice, appearance: e.target.value === "dark" ? "dark" : "light" })
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
                onChange={(e) => setChoice({ ...choice, embedImages: e.target.checked })}
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
          <button
            type="button"
            disabled={busy}
            onClick={() => dialog.current?.close()}
            className={buttonClass}
          >
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
