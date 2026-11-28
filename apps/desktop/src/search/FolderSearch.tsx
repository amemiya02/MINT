import type { MintEditor, OutlineHeading } from "@mint/editor";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { IconButton, Toggle } from "../find/FindBar.tsx";
import { type Translate, useT } from "../i18n/index.ts";
import { documentExtensions, lastSeparator } from "../paths.ts";
import type { FileMatches, FolderSearchQuery, LineMatch, Platform } from "../platform/platform.ts";
import type { LineRange } from "../tabs/tab-store.ts";

export interface FolderSearchProps {
  readonly platform: Platform;
  readonly editor: MintEditor | null;
  readonly documentName: string | null;
  readonly folder: string | null;
  /** Changes every time search is invoked, so the panel refocuses its field. */
  readonly request: number;
  readonly onOpenDocument: (path: string, select?: LineRange) => void;
  readonly onClose: () => void;
}

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "done"; readonly truncated: boolean }
  | { readonly kind: "invalid" };

/** Typing pauses this long before a new search starts. */
const debounceMs = 120;
/** The backend's cap on matching lines (`search::MAX_LINES`), quoted in the truncation notice. */
const maxLines = 10_000;

function useHeadingMatches(
  editor: MintEditor | null,
  platform: Platform,
  query: FolderSearchQuery,
) {
  const [matches, setMatches] = useState<readonly OutlineHeading[]>([]);
  const [status, setStatus] = useState<Status["kind"]>("idle");
  useEffect(() => {
    setMatches([]);
    if (!editor || !query.pattern) {
      setStatus("idle");
      return;
    }
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const current = ++generation;
      clearTimeout(timer);
      setMatches([]);
      setStatus("searching");
      timer = setTimeout(async () => {
        const outline = editor.getOutline();
        try {
          const indices = await platform.matchSearchLabels(
            query,
            outline.map((h) => h.text),
          );
          if (current !== generation) return;
          setMatches(indices.flatMap((index) => outline[index] ?? []));
          setStatus("done");
        } catch {
          if (current === generation) setStatus("invalid");
        }
      }, debounceMs);
    };
    update();
    const unsubscribe = editor.subscribe((event) => {
      if (event.type === "outline") update();
    });
    return () => {
      generation++;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [editor, platform, query]);
  return { matches, status };
}

/** Search folder file names and contents alongside the active draft's headings. */
export function FolderSearch(props: FolderSearchProps) {
  const { platform, folder, editor, documentName, request, onOpenDocument, onClose } = props;
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [pattern, setPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [files, setFiles] = useState<readonly FileMatches[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const query = useMemo(
    () => ({ pattern, caseSensitive, wholeWord, regexp }),
    [pattern, caseSensitive, wholeWord, regexp],
  );
  const headings = useHeadingMatches(editor, platform, query);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per invocation.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [request]);

  useEffect(() => {
    setFiles([]);
    if (folder === null || query.pattern === "") {
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "searching" });
    let live = true;
    let cancel: (() => void) | null = null;
    // Files arriving in quick succession are shown together, once per frame.
    let buffer: FileMatches[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const arrived = buffer;
      buffer = [];
      setFiles((shown) => [...shown, ...arrived]);
    };
    const timer = setTimeout(() => {
      platform
        .searchFolder(folder, query, documentExtensions, {
          onFile(file) {
            if (!live) return;
            buffer.push(file);
            if (frame === 0) frame = requestAnimationFrame(flush);
          },
          onDone({ truncated }) {
            if (!live) return;
            cancelAnimationFrame(frame);
            flush();
            setStatus({ kind: "done", truncated });
          },
        })
        .then(
          (stop) => {
            if (live) cancel = stop;
            else stop();
          },
          () => live && setStatus({ kind: "invalid" }),
        );
    }, debounceMs);
    return () => {
      live = false;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancel?.();
    };
  }, [platform, folder, query]);

  const names = files.filter((file) => file.nameMatches);
  const bodies = files.filter((file) => file.lines.length > 0);

  const invalid = status.kind === "invalid" || headings.status === "invalid";
  const searching = status.kind === "searching" || headings.status === "searching";
  let notice = "";
  if (invalid) notice = t("find.invalid");
  else if (searching) notice = t("search.searching");
  else if (folder === null) notice = t("search.noFolder");
  else if (pattern && !files.length && !headings.matches.length) notice = t("find.noResults");

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = results.current?.querySelectorAll("button");
    if (!buttons?.length) return;
    const current = Array.from(buttons).indexOf(event.target as HTMLButtonElement);
    if (current < 0 && event.target !== field.current) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? current + 1 : Math.max(0, current) - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }

  return (
    <search
      aria-label={t("search.label")}
      onKeyDown={onKeyDown}
      className="flex h-full w-72 shrink-0 flex-col border-r border-(--mint-border) bg-(--mint-sidebar-bg) text-sm"
    >
      <header className="flex flex-col gap-1.5 border-b border-(--mint-border) px-2 py-1.5">
        <div className="flex items-center gap-1">
          <span className="flex-1 truncate text-xs font-semibold">{t("search.label")}</span>
          <IconButton label={t("search.close")} onClick={onClose}>
            ×
          </IconButton>
        </div>
        <input
          ref={field}
          type="text"
          aria-label={t("search.label")}
          placeholder={t("find.label")}
          aria-invalid={invalid}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded border border-(--mint-border) bg-(--mint-bg) px-2 py-0.5 text-(--mint-fg) outline-none focus:border-(--mint-accent) aria-invalid:border-(--mint-error-fg)"
        />
        <div className="flex items-center gap-1">
          <Toggle
            pressed={caseSensitive}
            onChange={setCaseSensitive}
            label={t("find.caseSensitive")}
          >
            Aa
          </Toggle>
          <Toggle pressed={wholeWord} onChange={setWholeWord} label={t("find.wholeWord")}>
            <span className="underline decoration-dotted underline-offset-2">ab</span>
          </Toggle>
          <Toggle pressed={regexp} onChange={setRegexp} label={t("find.regexp")}>
            .*
          </Toggle>
        </div>
        <output aria-live="polite" className="text-xs text-(--mint-muted)">
          {notice}
        </output>
      </header>
      <div ref={results} className="min-h-0 flex-1 overflow-auto py-1">
        {names.length > 0 && (
          <ResultGroup label={t("search.names")}>
            {names.map(({ path }) => (
              <li key={path}>
                <button
                  type="button"
                  title={path}
                  className={resultClass}
                  onClick={() => onOpenDocument(path)}
                >
                  {relativeTo(folder ?? "", path)}
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {editor && headings.matches.length > 0 && (
          <ResultGroup label={t("search.headings")} detail={documentName}>
            {headings.matches.map((heading) => (
              <li key={heading.from}>
                <button
                  type="button"
                  className={resultClass}
                  title={heading.text}
                  onClick={() => {
                    editor.setSelection({ anchor: heading.from, scrollIntoView: "start" });
                    editor.focus();
                  }}
                >
                  <span className="mr-2 text-(--mint-muted)">H{heading.level}</span>
                  {heading.text}
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {bodies.length > 0 && (
          <ResultGroup label={t("search.body")} detail={bodySummary(t, bodies)}>
            {bodies.map((file) => (
              <FileResults
                key={file.path}
                file={file}
                label={relativeTo(folder ?? "", file.path)}
                onChoose={(line, [from, to]) =>
                  onOpenDocument(file.path, { line: line.line, text: line.text, from, to })
                }
              />
            ))}
          </ResultGroup>
        )}
      </div>
      {status.kind === "done" && status.truncated && (
        <p className="border-t border-(--mint-border) px-2 py-1.5 text-xs text-(--mint-muted)">
          {t("search.truncated", { count: maxLines.toLocaleString() })}
        </p>
      )}
    </search>
  );
}

function bodySummary(t: Translate, files: readonly FileMatches[]): string {
  const matches = files.reduce(
    (sum, f) => sum + f.lines.reduce((n, l) => n + l.ranges.length, 0),
    0,
  );
  const count = (key: "search.matches" | "search.documents", n: number) =>
    n === 1 ? t(`${key}.one`) : t(`${key}.other`, { count: String(n) });
  return t("search.summary", {
    matches: count("search.matches", matches),
    documents: count("search.documents", files.length),
  });
}

const resultClass =
  "block w-full truncate px-2 py-0.5 text-left text-xs hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--mint-accent)";

function ResultGroup({
  label,
  detail,
  children,
}: {
  readonly label: string;
  readonly detail?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={label} className="pb-2">
      <h2 className="px-2 text-xs font-semibold text-(--mint-muted)">{label}</h2>
      {detail && <p className="px-2 text-xs text-(--mint-muted)">{detail}</p>}
      <ul>{children}</ul>
    </section>
  );
}

function FileResults(props: {
  readonly file: FileMatches;
  readonly label: string;
  readonly onChoose: (line: LineMatch, range: readonly [number, number]) => void;
}) {
  const { file, label, onChoose } = props;
  const slash = lastSeparator(label);
  return (
    <li data-file={label.replaceAll("\\", "/")}>
      <div className="flex items-baseline gap-1.5 px-2 pt-1 text-xs" title={file.path}>
        <span className="font-semibold">{label.slice(slash + 1)}</span>
        {slash > 0 && <span className="truncate text-(--mint-muted)">{label.slice(0, slash)}</span>}
      </div>
      <ul>
        {file.lines.map((line) => (
          <li key={line.line}>
            <button
              type="button"
              onClick={() => line.ranges[0] && onChoose(line, line.ranges[0])}
              className={resultClass}
            >
              <span className="mr-2 text-(--mint-muted)">{line.line}</span>
              <Snippet line={line} />
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Characters of context shown before the first match of a long line. */
const leadingContext = 24;

/** The line around its first match, with the matches emphasised. */
function Snippet({ line }: { readonly line: LineMatch }) {
  const { text, ranges } = line;
  const lineStart = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a byte order mark
  let start = lineStart;
  const first = ranges[0]?.[0] ?? 0;
  if (first - start > leadingContext) start = first - leadingContext;
  while (start < first && /\s/.test(text.charAt(start))) start++;
  const parts: ReactNode[] = [];
  if (start > lineStart) parts.push("…");
  let at = start;
  for (const [from, to] of ranges) {
    if (to <= at) continue;
    const begin = Math.max(from, at);
    if (begin > at) parts.push(text.slice(at, begin));
    parts.push(
      <mark key={begin} className="rounded-sm bg-(--mint-accent)/25 text-(--mint-fg)">
        {text.slice(begin, to)}
      </mark>,
    );
    at = to;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function relativeTo(folder: string, path: string): string {
  return path.startsWith(folder) ? path.slice(folder.length).replace(/^[\\/]+/, "") : path;
}
