import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName, documentExtensions, isWithin } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { type FuzzyMatch, fuzzyMatch } from "./fuzzy.ts";

export interface QuickOpenProps {
  readonly platform: Platform;
  /** The open folder, whose documents are offered; without one, only recent documents are. */
  readonly folder: string | null;
  /** Recently opened documents, most recent first. */
  readonly recentDocuments: readonly string[];
  readonly onOpenDocument: (path: string) => void;
  readonly onClose: () => void;
}

interface Candidate {
  readonly path: string;
  /** What is shown and matched: the path relative to the folder, or the full path. */
  readonly label: string;
  /** Position in the recent list, or `null` if not recently opened. */
  readonly recent: number | null;
}

interface Result extends Candidate {
  readonly match: FuzzyMatch;
}

/** At most this many results are shown; typing narrows them down. */
const resultLimit = 100;

/** Recently opened documents first (most recent first), then by relevance. */
function rank(candidates: readonly Candidate[], query: string): Result[] {
  const results: Result[] = [];
  for (const candidate of candidates) {
    const match = fuzzyMatch(query, candidate.label);
    if (match) results.push({ ...candidate, match });
  }
  const noQuery = query.trim() === "";
  return results.sort(
    (a, b) =>
      (a.recent ?? Number.POSITIVE_INFINITY) - (b.recent ?? Number.POSITIVE_INFINITY) ||
      b.match.score - a.match.score ||
      (noQuery ? 0 : a.label.length - b.label.length) ||
      a.label.localeCompare(b.label),
  );
}

function useCandidates(
  platform: Platform,
  folder: string | null,
  recentDocuments: readonly string[],
): Candidate[] | null {
  const [paths, setPaths] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (folder === null) return;
    let live = true;
    platform.listFolderFiles(folder, documentExtensions).then(
      (listed) => live && setPaths(listed),
      // An unreadable folder simply offers nothing to open.
      () => live && setPaths([]),
    );
    return () => {
      live = false;
    };
  }, [platform, folder]);

  return useMemo(() => {
    const recentIndex = (path: string) => {
      const index = recentDocuments.indexOf(path);
      return index < 0 ? null : index;
    };
    if (folder === null) {
      return recentDocuments.map((path, index) => ({ path, label: path, recent: index }));
    }
    if (paths === null) return null;
    return paths
      .filter((path) => isWithin(path, folder))
      .map((path) => ({
        path,
        label: path.slice(folder.length).replace(/^[\\/]+/, ""),
        recent: recentIndex(path),
      }));
  }, [folder, paths, recentDocuments]);
}

/** Quick open: fuzzy-search the documents of the folder by name and open one. */
export function QuickOpen(props: QuickOpenProps) {
  const { platform, folder, recentDocuments, onOpenDocument, onClose } = props;
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const candidates = useCandidates(platform, folder, recentDocuments);
  const results = useMemo(
    () => (candidates ? rank(candidates, query).slice(0, resultLimit) : []),
    [candidates, query],
  );
  const current = Math.min(selected, results.length - 1);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function choose(result: Result | undefined) {
    if (!result) return;
    dialog.current?.close();
    onOpenDocument(result.path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    const move = (delta: number) => {
      event.preventDefault();
      setSelected((current + delta + results.length) % results.length);
    };
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(results[current]);
    }
  }

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current]);

  return (
    <dialog
      ref={dialog}
      aria-label={t("quickOpen.title")}
      onClose={onClose}
      onMouseDown={(event) => {
        // A click on the backdrop dismisses quick open.
        if (event.target === dialog.current) dialog.current.close();
      }}
      className="mx-auto mt-[12vh] w-[min(36rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-0 text-(--mint-fg) shadow-xl backdrop:bg-black/20"
    >
      <input
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results.length > 0 ? `${listId}-${current}` : undefined}
        aria-label={t("quickOpen.title")}
        placeholder={t(folder === null ? "quickOpen.placeholderRecent" : "quickOpen.placeholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        className="w-full border-b border-(--mint-border) bg-transparent px-4 py-2.5 text-sm outline-none"
      />
      <div id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
        {results.map((result, index) => (
          <div
            key={result.path}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === current}
            data-path={result.label}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => index !== current && setSelected(index)}
            tabIndex={-1}
            onClick={() => choose(result)}
            onKeyDown={(event) => event.key === "Enter" && choose(result)}
            className={`flex cursor-default items-baseline gap-2 px-4 py-1 text-sm ${
              index === current ? "bg-(--mint-hover)" : ""
            }`}
          >
            <Label result={result} />
            {result.recent !== null && (
              <span className="ml-auto shrink-0 text-xs text-(--mint-muted)">
                {t("quickOpen.recent")}
              </span>
            )}
          </div>
        ))}
      </div>
      {candidates !== null && results.length === 0 && (
        <p className="px-4 py-3 text-sm text-(--mint-muted)">
          {t(query.trim() === "" ? "quickOpen.empty" : "quickOpen.noMatches")}
        </p>
      )}
    </dialog>
  );
}

/** The file name, then its folder in muted text, with the matched letters emphasised. */
function Label({ result }: { readonly result: Result }) {
  const { label, match } = result;
  const name = baseName(label);
  const nameStart = label.length - name.length;
  const matched = new Set(match.positions);
  const highlight = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => {
      const at = from + i;
      const char = label.charAt(at);
      return matched.has(at) ? (
        <b key={at} className="font-semibold text-(--mint-accent)">
          {char}
        </b>
      ) : (
        char
      );
    });
  return (
    <>
      <span className="shrink-0">{highlight(nameStart, label.length)}</span>
      {nameStart > 0 && (
        <span className="truncate text-xs text-(--mint-muted)">
          {highlight(0, Math.max(0, nameStart - 1))}
        </span>
      )}
    </>
  );
}
