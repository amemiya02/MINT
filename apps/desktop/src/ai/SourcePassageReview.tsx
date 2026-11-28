import type { MintEditor } from "@mint/editor";
import { useEffect, useId, useMemo, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { materialLabel } from "./material-display.ts";
import { usableMaterialText } from "./material-source.ts";
import {
  type AffectedStatement,
  SourceVerification,
  type VerificationRecipient,
} from "./SourceVerification.tsx";
import { compareSource, readSourceRevision, sentSource } from "./source-comparison.ts";
import type { SourceExcerpt, SourcePassage } from "./source-passages.ts";
import type { NamedMaterial, TaskContext } from "./writing-sender.ts";
import { mapReviewRanges } from "./writing-tasks.ts";

const button = "rounded px-1 text-left text-(--mint-accent) underline focus-visible:outline-2";

function citationText(text: string) {
  return text
    .replace(/\r\n|\r|\n/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|~&$^=]/g, "\\$&");
}

function locate(passage: SourcePassage, live: string, mapper: ReturnType<typeof mapReviewRanges>) {
  const range = mapper.range({
    from: passage.from,
    to: passage.from + passage.claim.length,
    located: true,
  });
  if (range.located && live.slice(range.from, range.to) === passage.claim) return range;
}

export function SourcePassageReview({
  draft,
  passages,
  editor,
  context,
  platform,
  recipients,
  originalRecipient,
}: {
  readonly draft: string;
  readonly passages: readonly SourcePassage[];
  readonly editor?: MintEditor | null;
  readonly context?: TaskContext;
  readonly platform: Platform;
  readonly recipients: readonly VerificationRecipient[];
  readonly originalRecipient: string;
}) {
  const t = useT();
  const detailId = useId();
  const [selected, setSelected] = useState<SourcePassage | null>(null);
  const [citationStatus, setCitationStatus] = useState<MessageKey | null>(null);
  const [revisions, setRevisions] = useState<ReadonlyMap<NamedMaterial | SourceExcerpt, string>>(
    () => new Map(),
  );
  const [reading, setReading] = useState<SourceExcerpt | null>(null);
  const [readError, setReadError] = useState<SourceExcerpt | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [disk, setDisk] = useState<{
    generation: number;
    files: ReadonlyMap<string, string | null>;
  }>();
  const sourcePaths = useMemo(
    () =>
      new Set(
        passages.flatMap(({ excerpts }) =>
          excerpts.flatMap(({ sourceFile }) => (sourceFile ? [sourceFile.path] : [])),
        ),
      ),
    [passages],
  );
  useEffect(() => {
    if (sourcePaths.size === 0) return;
    let current = true;
    void Promise.all(
      [...sourcePaths].map(async (path) => {
        try {
          const text = await platform.readTextFile(path);
          return [path, usableMaterialText(text, { allowBlank: true }) ? text : null] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((files) => {
      if (current) setDisk({ generation: refresh, files: new Map(files) });
    });
    return () => {
      current = false;
    };
  }, [platform, refresh, sourcePaths]);
  const [live, setLive] = useState(() => editor?.getText() ?? draft);
  useEffect(() => {
    setLive(editor?.getText() ?? draft);
    return editor?.subscribe(({ type }) => {
      if (type === "change") setLive(editor.getText());
    });
  }, [draft, editor]);

  const comparisons = useMemo(() => {
    const current = new Map<SourceExcerpt, string>();
    const files = disk?.generation === refresh ? disk.files : undefined;
    if (revisions.size === 0 && !files) return current;
    for (const { excerpts } of passages) {
      for (const excerpt of excerpts) {
        const sent = sentSource(excerpt, context);
        const revision =
          revisions.get(sent ?? excerpt) ??
          (excerpt.sourceFile ? files?.get(excerpt.sourceFile.path) : undefined);
        if (revision != null) {
          current.set(excerpt, compareSource(excerpt, revision, sent?.text));
        }
      }
    }
    return current;
  }, [context, disk, passages, refresh, revisions]);
  const statements = useMemo(() => {
    const result: AffectedStatement[] = [];
    if (!comparisons.size) return result;
    const mapper = mapReviewRanges(draft, live);
    for (const passage of passages) {
      const evidence = passage.excerpts.flatMap((excerpt) => {
        const revised = comparisons.get(excerpt);
        return revised === undefined || revised === excerpt.quote
          ? []
          : [{ source: materialLabel(excerpt, t), original: excerpt.quote, revised }];
      });
      if (evidence.length && locate(passage, live, mapper))
        result.push({ id: result.length + 1, claim: passage.claim, evidence });
    }
    return result;
  }, [comparisons, draft, live, passages, t]);

  async function chooseRevision(excerpt: SourceExcerpt) {
    if (reading) return;
    setReading(excerpt);
    setReadError(null);
    try {
      const file = await platform.pickFile(
        excerpt.range?.kind === "pdf" && excerpt.format === "extractedText"
          ? ".pdf,application/pdf"
          : ".md,.markdown,.txt,.csv,.tsv,.json,text/*",
      );
      if (!file) return;
      const text = await readSourceRevision(file, excerpt);
      const key = sentSource(excerpt, context) ?? excerpt;
      setRevisions((previous) => new Map(previous).set(key, text));
    } catch {
      setReadError(excerpt);
    } finally {
      setReading(null);
    }
  }

  function reveal(passage: SourcePassage) {
    setCitationStatus(null);
    setSelected(selected === passage ? null : passage);
    if (!editor || selected === passage) return;
    const live = editor.getText();
    const range = locate(passage, live, mapReviewRanges(draft, live));
    if (range) editor.setSelection({ anchor: range.from, head: range.to, scrollIntoView: true });
  }

  function cite(passage: SourcePassage) {
    if (!editor) return;
    const live = editor.getText();
    const range = locate(passage, live, mapReviewRanges(draft, live));
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
    const notes = passage.excerpts.map((excerpt) =>
      t("sources.citationEntry", {
        name: citationText(materialLabel(excerpt, t)),
        line: String(excerpt.line),
        quote: citationText(excerpt.quote),
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
          {selected.excerpts.map((excerpt, index) => {
            const revised = comparisons.get(excerpt);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: Excerpts stay in their original order.
              <figure key={index} className="space-y-1 wrap-anywhere">
                <figcaption>
                  <strong>{materialLabel(excerpt, t)}</strong> ·{" "}
                  {t("sources.line", { line: String(excerpt.line) })}
                </figcaption>
                <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-(--mint-hover) p-2">
                  {excerpt.quote}
                </blockquote>
                {excerpt.sourceFile && (
                  <button
                    type="button"
                    className={button}
                    disabled={reading !== null || disk?.generation !== refresh}
                    onClick={() => {
                      setRevisions((previous) => {
                        const next = new Map(previous);
                        next.delete(sentSource(excerpt, context) ?? excerpt);
                        return next;
                      });
                      setRefresh((count) => count + 1);
                    }}
                  >
                    {t("sources.readCurrent")}
                  </button>
                )}
                <button
                  type="button"
                  className={button}
                  disabled={reading !== null}
                  onClick={() => void chooseRevision(excerpt)}
                >
                  {t("sources.chooseRevision")}
                </button>
                {readError === excerpt && <p role="alert">{t("sources.unreadable")}</p>}
                {excerpt.sourceFile &&
                  disk?.generation === refresh &&
                  disk.files.get(excerpt.sourceFile.path) === null &&
                  revised === undefined && <p>{t("sources.currentUnavailable")}</p>}
                {revised !== undefined && (
                  <section aria-label={t("sources.comparison")}>
                    <p className="font-medium">{t("sources.revisedExcerpt")}</p>
                    {revised === excerpt.quote ? (
                      <p>{t("sources.unchanged")}</p>
                    ) : revised ? (
                      <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-(--mint-hover) p-2">
                        {revised}
                      </blockquote>
                    ) : (
                      <p>{t("sources.removed")}</p>
                    )}
                  </section>
                )}
              </figure>
            );
          })}
          {editor && (
            <button type="button" className={button} onClick={() => cite(selected)}>
              {t(
                selected.excerpts.some((excerpt) => {
                  const revised = comparisons.get(excerpt);
                  return revised !== undefined && revised !== excerpt.quote;
                })
                  ? "sources.insertOriginalCitation"
                  : "sources.insertCitation",
              )}
            </button>
          )}
          {citationStatus && <p role="status">{t(citationStatus)}</p>}
        </section>
      )}
      {!!statements.length && (
        <SourceVerification
          key={JSON.stringify(statements)}
          statements={statements}
          recipients={recipients}
          originalRecipient={originalRecipient}
        />
      )}
    </section>
  );
}
