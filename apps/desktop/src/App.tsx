import type { MintEditor } from "@mint/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildMenu, type CommandId } from "./commands.ts";
import { EditorPane } from "./EditorPane.tsx";
import { useT } from "./i18n/index.ts";
import type { Platform } from "./platform/platform.ts";
import { baseName, documentExtensions, isWithin, rebasePath } from "./workspace/paths.ts";
import { useRecent } from "./workspace/recent.ts";
import { Sidebar } from "./workspace/Sidebar.tsx";

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
  const [folder, setFolder] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const { recent, add: addRecent } = useRecent(platform);
  const editor = useRef<MintEditor | null>(null);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const current = useRef(document);
  current.current = document;

  /** Write the current document to disk. Resolves to whether it is now saved. */
  const saveDocument = useCallback(async (): Promise<boolean> => {
    const doc = current.current;
    if (!doc || !editor.current) return true;
    const saving = version.current;
    try {
      await platform.writeTextFile(doc.path, editor.current.getText());
      savedVersion.current = saving;
      setDirty(version.current !== saving);
      setError(null);
      return true;
    } catch (e) {
      setError(t("error.save", { path: doc.path, reason: reasonOf(e) }));
      return false;
    }
  }, [platform, t]);

  /**
   * The single entry point for showing a document in the editor (dialog, file
   * tree, recent list). Unsaved edits to the current document are saved first.
   */
  const openDocument = useCallback(
    async (path: string) => {
      if (current.current?.path === path) return;
      if (version.current !== savedVersion.current && !(await saveDocument())) return;
      try {
        const text = await platform.readTextFile(path);
        version.current = savedVersion.current = 0;
        setDocument({ path, text, session: nextSession++ });
        setDirty(false);
        setError(null);
        addRecent("document", path);
      } catch (e) {
        setError(t("error.open", { path, reason: reasonOf(e) }));
      }
    },
    [platform, t, saveDocument, addRecent],
  );

  const openFolder = useCallback(
    async (path: string) => {
      try {
        await platform.readDirectory(path);
      } catch (e) {
        setError(t("error.openFolder", { path, reason: reasonOf(e) }));
        return;
      }
      setFolder(path);
      setSidebarVisible(true);
      setError(null);
      addRecent("folder", path);
    },
    [platform, t, addRecent],
  );

  const pickDocument = useCallback(async () => {
    const path = await platform.showOpenDialog({
      title: t("dialog.open.title"),
      filters: [{ name: t("dialog.filter.markdown"), extensions: documentExtensions }],
    });
    if (path) await openDocument(path);
  }, [platform, t, openDocument]);

  const pickFolder = useCallback(async () => {
    const path = await platform.showOpenFolderDialog({ title: t("dialog.openFolder.title") });
    if (path) await openFolder(path);
  }, [platform, t, openFolder]);

  const handlers = useRef<Record<CommandId, () => void>>({} as Record<CommandId, () => void>);
  handlers.current = {
    "file.open": () => void pickDocument(),
    "file.openFolder": () => void pickFolder(),
    "file.save": () => void saveDocument(),
    "view.toggleSidebar": () => setSidebarVisible((visible) => !visible),
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

  const onRenamed = useCallback((from: string, to: string) => {
    setDocument((doc) => (doc ? { ...doc, path: rebasePath(doc.path, from, to) } : doc));
  }, []);
  const onTrashed = useCallback((path: string) => {
    setDocument((doc) => (doc && isWithin(doc.path, path) ? null : doc));
  }, []);

  return (
    <div className="flex h-full flex-col bg-(--mint-bg) text-(--mint-fg)">
      {error && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {folder && sidebarVisible && (
          <Sidebar
            platform={platform}
            root={folder}
            activePath={document?.path ?? null}
            onOpenDocument={(path) => void openDocument(path)}
            onRenamed={onRenamed}
            onTrashed={onTrashed}
            onError={setError}
            onHide={() => setSidebarVisible(false)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <main aria-label={name ?? t("app.name")} className="min-h-0 flex-1">
            {document ? (
              <EditorPane
                key={document.session}
                text={document.text}
                onReady={onReady}
                onChange={onChange}
              />
            ) : (
              <Welcome
                recent={recent}
                onPickDocument={() => void pickDocument()}
                onPickFolder={() => void pickFolder()}
                onOpenDocument={(path) => void openDocument(path)}
                onOpenFolder={(path) => void openFolder(path)}
              />
            )}
          </main>
          {document && (
            <footer className="flex items-center justify-between border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
              <span title={document.path}>{name}</span>
              <span>{t(dirty ? "status.unsaved" : "status.saved")}</span>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome(props: {
  readonly recent: { readonly documents: readonly string[]; readonly folders: readonly string[] };
  readonly onPickDocument: () => void;
  readonly onPickFolder: () => void;
  readonly onOpenDocument: (path: string) => void;
  readonly onOpenFolder: (path: string) => void;
}) {
  const t = useT();
  const { recent } = props;
  const button =
    "rounded-md border border-(--mint-border) px-4 py-1.5 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
  const entries = [
    ...recent.folders.map((path) => ({ path, open: props.onOpenFolder, folder: true })),
    ...recent.documents.map((path) => ({ path, open: props.onOpenDocument, folder: false })),
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-medium">{t("welcome.title")}</h1>
      <p className="text-sm text-(--mint-muted)">{t("welcome.body")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={props.onPickDocument} className={button}>
          {t("welcome.open")}
        </button>
        <button type="button" onClick={props.onPickFolder} className={button}>
          {t("welcome.openFolder")}
        </button>
      </div>
      {entries.length > 0 && (
        <section aria-labelledby="recent-heading" className="mt-6 w-full max-w-md text-left">
          <h2
            id="recent-heading"
            className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-(--mint-muted)"
          >
            {t("welcome.recent")}
          </h2>
          <ul>
            {entries.map((entry) => (
              <li key={`${entry.folder}:${entry.path}`}>
                <button
                  type="button"
                  onClick={() => entry.open(entry.path)}
                  className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
                >
                  <span className={entry.folder ? "font-medium" : ""}>
                    {baseName(entry.path)}
                    {entry.folder ? "/" : ""}
                  </span>
                  <span className="truncate text-xs text-(--mint-muted)">{entry.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
