import type { MintEditor } from "@mint/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildMenu, type CommandId } from "./commands.ts";
import { EditorPane } from "./EditorPane.tsx";
import { useT } from "./i18n/index.ts";
import type { Platform } from "./platform/platform.ts";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";

interface OpenDocument {
  readonly path: string;
  /** Text as read from disk; the editor owns the live text. */
  readonly text: string;
  /** Distinguishes reopening the same path, so the editor is recreated. */
  readonly session: number;
}

let nextSession = 1;

export function App({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const [document, setDocument] = useState<OpenDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editor = useRef<MintEditor | null>(null);
  const version = useRef(0);

  const openPath = useCallback(
    async (path: string) => {
      try {
        const text = await platform.readTextFile(path);
        setDocument({ path, text, session: nextSession++ });
        setDirty(false);
        setError(null);
      } catch (e) {
        setError(t("error.open", { path, reason: reasonOf(e) }));
      }
    },
    [platform, t],
  );

  const openDocument = useCallback(async () => {
    const path = await platform.showOpenDialog({
      title: t("dialog.open.title"),
      filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
    });
    if (path) await openPath(path);
  }, [platform, t, openPath]);

  const saveDocument = useCallback(async () => {
    if (!document || !editor.current) return;
    const savedVersion = version.current;
    try {
      await platform.writeTextFile(document.path, editor.current.getText());
      setDirty(version.current !== savedVersion);
      setError(null);
    } catch (e) {
      setError(t("error.save", { path: document.path, reason: reasonOf(e) }));
    }
  }, [document, platform, t]);

  const handlers = useRef<Record<CommandId, () => void>>({} as Record<CommandId, () => void>);
  handlers.current = {
    "file.open": () => void openDocument(),
    "file.save": () => void saveDocument(),
    "app.settings": () => setSettingsOpen(true),
  };

  useEffect(() => {
    void platform.setMenu(buildMenu(t, (id) => handlers.current[id]()));
  }, [platform, t]);

  const name = document ? baseName(document.path) : null;
  useEffect(() => {
    const title = name
      ? t(dirty ? "window.titleUnsaved" : "window.title", { name })
      : t("app.name");
    void platform.setWindowTitle(title);
  }, [name, dirty, platform, t]);

  const onChange = useCallback(() => {
    version.current++;
    setDirty(true);
  }, []);
  const onReady = useCallback((instance: MintEditor | null) => {
    editor.current = instance;
  }, []);

  return (
    <div className="flex h-full flex-col bg-(--mint-bg) text-(--mint-fg)">
      <SettingsIssues />{" "}
      {error && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {error}
        </div>
      )}
      <main className="min-h-0 flex-1">
        {document ? (
          <EditorPane
            key={document.session}
            text={document.text}
            onReady={onReady}
            onChange={onChange}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <h1 className="text-lg font-medium">{t("welcome.title")}</h1>
            <p className="text-sm text-(--mint-muted)">{t("welcome.body")}</p>
            <button
              type="button"
              onClick={() => void openDocument()}
              className="mt-2 rounded-md border border-(--mint-border) px-4 py-1.5 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
            >
              {t("welcome.open")}
            </button>
          </div>
        )}
      </main>
      {document && (
        <footer className="flex items-center justify-between border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
          <span title={document.path}>{name}</span>
          <span>{t(dirty ? "status.unsaved" : "status.saved")}</span>
        </footer>
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onOpenFile={openPath} />
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
