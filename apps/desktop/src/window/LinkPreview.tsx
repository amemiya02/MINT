import { type DocumentLink, documentFragment, renderLinkPreview } from "@mint/editor";
import { useEffect, useRef, useState } from "react";
import { documentImageUrl } from "../assets/image-host.ts";
import { resolveDocumentLink } from "../folder/wikilinks.ts";
import { useT } from "../i18n/index.ts";
import { isAbsolutePath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useDialect } from "../settings/useDialect.ts";
import { useTabStore } from "../tabs/context.ts";
import { tabName } from "../tabs/tab-name.ts";
import type { Tab } from "../tabs/tab-store.ts";
import { useModalDialog } from "./useModalDialog.ts";

export function LinkPreview({
  source,
  wikilinkFolder,
  link,
  platform,
  onClose,
}: {
  readonly source: Tab;
  readonly wikilinkFolder: string | null;
  readonly link: DocumentLink;
  readonly platform: Platform;
  readonly onClose: () => void;
}) {
  const t = useT();
  const store = useTabStore();
  const dialect = useDialect();
  const { close, props } = useModalDialog(onClose);
  const article = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<{ path: string | null } | { error: string } | null>(null);
  const ready = status && "path" in status ? status : null;
  const label = link.path || tabName(t, source);
  const name = ready?.path ?? label;

  useEffect(() => {
    let current = true;
    setStatus(null);
    let displayPath = label;
    async function load() {
      const target = await resolveDocumentLink(platform, wikilinkFolder, source.path, link, t);
      if (!current) return;
      if ("error" in target) {
        setStatus(target);
        return;
      }
      const { path } = target;
      displayPath = path ?? label;
      const tab = link.path ? store.getState().tabs.find((tab) => tab.path === path) : source;
      let text: string;
      if (tab) text = store.getText(tab.id) ?? tab.text;
      else if (path && isAbsolutePath(path)) text = await platform.readTextFile(path);
      else {
        setStatus({ error: t("preview.saveFirst", { path: link.path }) });
        return;
      }
      if (!current) return;
      const rendered = renderLinkPreview(text, dialect, link.fragment);
      if ("error" in rendered) {
        setStatus({ error: t(`error.${rendered.error}`, { fragment: rendered.fragment }) });
        return;
      }
      const content = documentFragment(rendered.html, (image) =>
        documentImageUrl(platform, path, image),
      );
      // A preview is a reading surface. Links in it must not navigate the app's webview.
      for (const anchor of content.querySelectorAll("a[href]")) anchor.removeAttribute("href");
      article.current?.replaceChildren(content);
      setStatus(target);
    }
    void load().catch((error: unknown) => {
      if (current)
        setStatus({ error: t("error.open", { path: displayPath, reason: String(error) }) });
    });
    return () => {
      current = false;
    };
  }, [dialect, link, label, platform, source, store, t, wikilinkFolder]);

  return (
    <dialog
      {...props}
      aria-label={t("preview.title")}
      className="m-auto w-[min(38rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) text-(--mint-fg) shadow-xl backdrop:bg-black/20"
    >
      <header className="flex items-center justify-between gap-4 border-b border-(--mint-border) px-4 py-2">
        <span className="truncate" title={name}>
          {label}
          {link.fragment && `#${link.fragment}`}
        </span>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
            onClick={close}
          >
            {t("preview.close")}
          </button>
          <button
            type="button"
            disabled={!ready}
            className="rounded px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50"
            onClick={() => {
              if (!ready) return;
              close();
              store.openInOtherPane(source.id, { path: ready.path, fragment: link.fragment });
            }}
          >
            {t("command.view.openInOtherPane")}
          </button>
        </div>
      </header>
      <section
        aria-label={name}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard readers scroll long previews here.
        tabIndex={0}
        className="max-h-[60vh] overflow-auto px-5 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--mint-accent)"
      >
        {!status && <p role="status">{t("preview.loading")}</p>}
        {status && "error" in status && <p role="alert">{status.error}</p>}
        <article hidden={!ready} ref={article} className="mint-document mint-link-preview" />
      </section>
    </dialog>
  );
}
