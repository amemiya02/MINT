import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton, Toggle } from "../find/FindBar.tsx";
import { type Translate, useT } from "../i18n/index.ts";
import type { FileMatches, LineMatch, Platform } from "../platform/platform.ts";
import type { LineRange } from "../tabs/tab-store.ts";
import { documentExtensions } from "../workspace/paths.ts";

export interface FolderSearchProps {
  readonly platform: Platform;
  /** The open folder; without one there is nothing to search. */
  readonly folder: string | null;
  /** Changes every time search is invoked, so the panel refocuses its field. */
  readonly request: number;
  readonly onOpenDocument: (path: string, select: LineRange) => void;
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

/**
 * Global search: find text in every document of the folder (the backend skips
 * files ignored by `.gitignore`). Results stream in file by file; choosing a
 * match opens its document with the match selected.
 */
export function FolderSearch(props: FolderSearchProps) {
  const { platform, folder, request, onOpenDocument, onClose } = props;
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const [pattern, setPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [files, setFiles] = useState<readonly FileMatches[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per invocation.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [request]);

  useEffect(() => {
    setFiles([]);
    if (folder === null || pattern === "") {
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
      const query = { pattern, caseSensitive, wholeWord, regexp };
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
  }, [platform, folder, pattern, caseSensitive, wholeWord, regexp]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
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
          aria-invalid={status.kind === "invalid"}
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
          {folder === null ? t("search.noFolder") : summary(t, status, files)}
        </output>
      </header>
      <ul className="min-h-0 flex-1 overflow-auto py-1">
        {files.map((file) => (
          <FileResults
            key={file.path}
            file={file}
            label={relativeTo(folder ?? "", file.path)}
            onChoose={(line, [from, to]) => onOpenDocument(file.path, { line, from, to })}
          />
        ))}
      </ul>
      {status.kind === "done" && status.truncated && (
        <p className="border-t border-(--mint-border) px-2 py-1.5 text-xs text-(--mint-muted)">
          {t("search.truncated", { count: maxLines.toLocaleString() })}
        </p>
      )}
    </search>
  );
}

function summary(t: Translate, status: Status, files: readonly FileMatches[]): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "invalid":
      return t("find.invalid");
    case "searching":
      if (files.length === 0) return t("search.searching");
      break;
    case "done":
      if (files.length === 0) return t("find.noResults");
  }
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

function FileResults(props: {
  readonly file: FileMatches;
  readonly label: string;
  readonly onChoose: (line: number, range: readonly [number, number]) => void;
}) {
  const { file, label, onChoose } = props;
  const slash = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\"));
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
              onClick={() => line.ranges[0] && onChoose(line.line, line.ranges[0])}
              className="block w-full truncate px-2 py-0.5 pl-5 text-left text-xs hover:bg-(--mint-hover) focus-visible:bg-(--mint-hover) focus-visible:outline-none"
            >
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
