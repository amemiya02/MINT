import type { MintEditor, OutlineHeading } from "@mint/editor";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";

/** Index of the heading whose section contains `position`, or -1 before the first heading. */
export function sectionAt(headings: readonly OutlineHeading[], position: number): number {
  let index = -1;
  headings.forEach((heading, i) => {
    if (heading.from <= position) index = i;
  });
  return index;
}

/**
 * Where the reader is: the cursor while it is on screen, otherwise the top of
 * the editor (the user scrolled away from the cursor).
 */
function readingPosition(editor: MintEditor): number {
  const { head } = editor.getSelection();
  const { from, to } = editor.getVisibleRange();
  return head >= from && head <= to ? head : from;
}

/** The outline of a document: its headings, the current section highlighted; a click jumps to a heading. */
export function Outline({ editor }: { readonly editor: MintEditor | null }) {
  const t = useT();
  const [headings, setHeadings] = useState<readonly OutlineHeading[]>([]);
  const [current, setCurrent] = useState(-1);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      setCurrent(-1);
      return;
    }
    let latest = editor.getOutline();
    const update = (position: number) => setCurrent(sectionAt(latest, position));
    setHeadings(latest);
    update(readingPosition(editor));
    return editor.subscribe((event) => {
      if (event.type === "outline") {
        latest = editor.getOutline();
        setHeadings(latest);
        update(readingPosition(editor));
      } else if (event.type === "selection") {
        update(editor.getSelection().head);
      } else if (event.type === "scroll") {
        update(readingPosition(editor));
      }
    });
  }, [editor]);

  // Keep the highlighted heading visible in a long outline.
  useEffect(() => {
    if (current < 0) return;
    list.current
      ?.querySelector<HTMLElement>("[aria-current=location]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <nav aria-label={t("outline.label")} className="min-h-0 flex-1 overflow-auto px-1 py-1">
      {headings.length === 0 ? (
        <p className="px-2 py-1 text-sm text-(--mint-muted)">{t("outline.empty")}</p>
      ) : (
        <ul ref={list}>
          {headings.map((heading, index) => (
            <li key={heading.from}>
              <a
                href={`#outline-${index}`}
                aria-current={index === current ? "location" : undefined}
                title={heading.text}
                onClick={(event) => {
                  event.preventDefault();
                  if (!editor) return;
                  editor.setSelection({ anchor: heading.from, scrollIntoView: "start" });
                  editor.focus();
                }}
                className={[
                  "block truncate rounded-sm py-0.5 pr-2 text-sm outline-none",
                  "focus-visible:ring-2 focus-visible:ring-(--mint-accent)",
                  index === current
                    ? "bg-(--mint-selected) font-medium"
                    : "hover:bg-(--mint-hover)",
                ].join(" ")}
                style={{ paddingLeft: `${(heading.level - minLevel) * 12 + 8}px` }}
              >
                {heading.text || " "}
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
