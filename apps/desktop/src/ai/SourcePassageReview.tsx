import type { MintEditor } from "@mint/editor";
import { useId, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { SourcePassage } from "./source-passages.ts";
import { mapReviewRanges } from "./writing-tasks.ts";

const button = "rounded px-1 text-left text-(--mint-accent) underline focus-visible:outline-2";

function citationText(text: string) {
  return text
    .replace(/\r\n|\r|\n/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|~&$^=]/g, "\\$&");
}

export function SourcePassageReview({
  draft,
  passages,
  editor,
}: {
  readonly draft: string;
  readonly passages: readonly SourcePassage[];
  readonly editor?: MintEditor | null;
}) {
  const t = useT();
  const detailId = useId();
  const [selected, setSelected] = useState<SourcePassage | null>(null);
  const [citationStatus, setCitationStatus] = useState<MessageKey | null>(null);

  function locate(passage: SourcePassage, live: string) {
    const range = mapReviewRanges(draft, live).range({
      from: passage.from,
      to: passage.from + passage.claim.length,
      located: true,
    });
    if (range.located && live.slice(range.from, range.to) === passage.claim) return range;
  }

  function reveal(passage: SourcePassage) {
    setCitationStatus(null);
    setSelected(selected === passage ? null : passage);
    if (!editor || selected === passage) return;
    const range = locate(passage, editor.getText());
    if (range) editor.setSelection({ anchor: range.from, head: range.to, scrollIntoView: true });
  }

  function cite(passage: SourcePassage) {
    if (!editor) return;
    const live = editor.getText();
    const range = locate(passage, live);
    if (!range) {
      setCitationStatus("sources.claimChanged");
      return;
    }
    if (/^\[\^mint-source-\d+\]/i.test(live.slice(range.to))) {
      setCitationStatus("sources.citationExists");
      return;
    }
    const ids = new Set([...live.matchAll(/\[\^mint-source-(\d+)\]/gi)].map((match) => match[1]));
    let number = 1;
    while (ids.has(String(number))) number++;
    const reference = `[^mint-source-${number}]`;
    const notes = passage.excerpts.map(({ name, line, quote }) =>
      t("sources.citationEntry", {
        name: citationText(name),
        line: String(line),
        quote: citationText(quote),
      }),
    );
    const eol = /\r\n|\n|\r/.exec(live)?.[0] ?? "\n";
    const definition = `${eol}${eol}${reference}: ${notes.join(" ")}${eol}`;
    const end = live.length;
    const inline = { from: range.to, to: range.to, text: reference };
    const replacements = [inline];
    if (range.to === end) inline.text += definition;
    else replacements.push({ from: end, to: end, text: definition });
    editor.replaceRanges(replacements, { lineEndings: "preserve" });
    setCitationStatus("sources.citationInserted");
  }

  return (
    <section aria-label={t("sources.review")} className="space-y-1 text-sm">
      <h3 className="font-medium">{t("sources.review")}</h3>
      <ul className="max-h-24 space-y-1 overflow-auto">
        {passages.map((passage) => (
          <li key={passage.from} className="wrap-anywhere">
            {passage.excerpts.length ? (
              <button
                type="button"
                className={button}
                aria-controls={detailId}
                aria-expanded={selected === passage}
                onClick={() => reveal(passage)}
              >
                {passage.claim}
              </button>
            ) : (
              <>
                {passage.claim}{" "}
                <span className="text-(--mint-muted)">{t("sources.unverified")}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <section
          id={detailId}
          aria-label={t("sources.excerpt")}
          className="space-y-2 rounded border border-(--mint-border) p-2"
        >
          {selected.excerpts.map(({ name, quote, line }, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Excerpts stay in their original order.
            <figure key={index} className="space-y-1 wrap-anywhere">
              <figcaption>
                <strong>{name}</strong> · {t("sources.line", { line: String(line) })}
              </figcaption>
              <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-(--mint-hover) p-2">
                {quote}
              </blockquote>
            </figure>
          ))}
          {editor && (
            <button type="button" className={button} onClick={() => cite(selected)}>
              {t("sources.insertCitation")}
            </button>
          )}
          {citationStatus && <p role="status">{t(citationStatus)}</p>}
        </section>
      )}
    </section>
  );
}
