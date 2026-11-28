import type { MintEditor } from "@mint/editor";
import { type Dialect, renderHtml } from "@mint/markdown";
import { useState } from "react";
import { documentImageUrl } from "../assets/image-host.ts";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { canPresentSlides } from "./host.ts";

interface PresentationProps {
  editor: MintEditor | null;
  dialect: Dialect;
  platform: Platform;
  path: string | null;
}

function slidePages(html: string, platform: Platform, path: string | null) {
  const documentBody = document.createElement("template");
  documentBody.innerHTML = html;
  for (const image of documentBody.content.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") ?? "";
    if (/^(https?:|data:|\/\/)/i.test(src)) continue;
    let asset = src;
    try {
      asset = decodeURI(src);
    } catch {
      // A filename can contain a literal percent sign.
    }
    const url = documentImageUrl(platform, path, asset);
    if (url) image.src = url;
    else image.removeAttribute("src");
  }
  // Keep the presentation in the current window when a slide contains a link.
  for (const link of documentBody.content.querySelectorAll("a[href]")) link.removeAttribute("href");
  const pages: DocumentFragment[] = [document.createDocumentFragment()];
  for (const node of Array.from(documentBody.content.childNodes)) {
    if (node.nodeName === "HR") pages.push(document.createDocumentFragment());
    else pages[pages.length - 1]?.append(node);
  }
  return pages;
}

const button =
  "rounded border border-(--mint-border) px-3 py-1 text-sm hover:bg-(--mint-hover) disabled:opacity-40 aria-disabled:opacity-40";

export function PresentationEntry({ editor, dialect, platform, path }: PresentationProps) {
  const t = useT();
  const [pages, setPages] = useState<DocumentFragment[] | null>(null);
  return (
    <div className="border-t border-(--mint-border) px-4 py-1">
      <button
        type="button"
        className={button}
        disabled={!editor}
        onClick={() => {
          if (editor && canPresentSlides())
            setPages(slidePages(renderHtml(editor.getText(), dialect), platform, path));
        }}
      >
        {t("slides.present")}
      </button>
      {pages && (
        <Presentation
          pages={pages}
          onClose={() => {
            setPages(null);
            editor?.focus();
          }}
        />
      )}
    </div>
  );
}

function Presentation({ pages, onClose }: { pages: DocumentFragment[]; onClose: () => void }) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [index, setIndex] = useState(0);
  function pageBy(delta: number) {
    setIndex((i) => Math.max(0, Math.min(pages.length - 1, i + delta)));
  }
  return (
    <dialog
      {...props}
      aria-label={t("slides.name")}
      className="m-0 h-full max-h-none w-full max-w-none bg-(--mint-bg) text-(--mint-fg) open:flex open:flex-col"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight" || event.key === "PageDown") pageBy(1);
        else if (event.key === "ArrowLeft" || event.key === "PageUp") pageBy(-1);
        else return;
        event.preventDefault();
      }}
    >
      <article
        key={index}
        className="mint-link-preview min-h-0 flex-1 overflow-auto px-[8vw] py-[8vh] text-[clamp(1.25rem,3vw,2.75rem)]!"
        ref={(element) => {
          const page = pages[index];
          if (element && page) element.replaceChildren(page.cloneNode(true));
        }}
      />
      <footer className="flex items-center justify-center gap-3 border-t border-(--mint-border) p-3">
        <button
          type="button"
          className={button}
          aria-disabled={index === 0}
          onClick={() => pageBy(-1)}
        >
          {t("slides.previous")}
        </button>
        <span aria-live="polite">
          {t("slides.progress", { current: String(index + 1), total: String(pages.length) })}
        </span>
        <button
          type="button"
          className={button}
          aria-disabled={index === pages.length - 1}
          onClick={() => pageBy(1)}
        >
          {t("slides.next")}
        </button>
        <button type="button" className={button} onClick={close}>
          {t("slides.exit")}
        </button>
      </footer>
    </dialog>
  );
}
