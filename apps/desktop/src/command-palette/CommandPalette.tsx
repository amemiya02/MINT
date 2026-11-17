import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Command, type CommandId, commands, shortcutOf } from "../commands.ts";
import { useT } from "../i18n/index.ts";
import { ariaKeyShortcut, formatAccelerator } from "../keys.ts";
import { type FuzzyMatch, fuzzyMatch } from "../quick-open/fuzzy.ts";
import { useSettings } from "../settings/useSettings.ts";

export interface CommandPaletteProps {
  /** Run the chosen command; called after the palette has closed. */
  readonly onRun: (id: CommandId) => void;
  readonly onClose: () => void;
}

interface Result {
  readonly command: Command;
  readonly title: string;
  readonly match: FuzzyMatch;
}

/** Command palette: fuzzy-search every registered command by name and run one. */
export function CommandPalette({ onRun, onClose }: CommandPaletteProps) {
  const t = useT();
  const { shortcuts } = useSettings().settings;
  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useMemo(() => {
    const found: Result[] = [];
    for (const command of commands as readonly Command[]) {
      // The palette does not list itself.
      if (command.id === "view.commandPalette") continue;
      const title = t(command.title);
      const match = fuzzyMatch(query, title);
      if (match) found.push({ command, title, match });
    }
    // Registry order without a query; best match first with one.
    return query.trim() === "" ? found : found.sort((a, b) => b.match.score - a.match.score);
  }, [t, query]);
  const current = Math.min(selected, results.length - 1);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current]);

  function choose(result: Result | undefined) {
    if (!result) return;
    dialog.current?.close();
    onRun(result.command.id);
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

  return (
    <dialog
      ref={dialog}
      aria-label={t("commandPalette.title")}
      onClose={onClose}
      onMouseDown={(event) => {
        // A click on the backdrop dismisses the palette.
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
        aria-label={t("commandPalette.title")}
        placeholder={t("commandPalette.placeholder")}
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
        {results.map((result, index) => {
          const accelerator = shortcutOf(result.command, shortcuts);
          return (
            <div
              key={result.command.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              aria-keyshortcuts={accelerator ? ariaKeyShortcut(accelerator) : undefined}
              data-command={result.command.id}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== current && setSelected(index)}
              tabIndex={-1}
              onClick={() => choose(result)}
              onKeyDown={(event) => event.key === "Enter" && choose(result)}
              className={`flex cursor-default items-baseline gap-2 px-4 py-1 text-sm ${
                index === current ? "bg-(--mint-hover)" : ""
              }`}
            >
              <Title result={result} />
              {accelerator && (
                <kbd className="ml-auto shrink-0 font-sans text-xs text-(--mint-muted)">
                  {formatAccelerator(accelerator)}
                </kbd>
              )}
            </div>
          );
        })}
      </div>
      {results.length === 0 && (
        <p className="px-4 py-3 text-sm text-(--mint-muted)">{t("commandPalette.noMatches")}</p>
      )}
    </dialog>
  );
}

/** The command's name with the matched letters emphasised. */
function Title({ result }: { readonly result: Result }) {
  const matched = new Set(result.match.positions);
  return (
    <span className="truncate">
      {Array.from(result.title, (char, at) =>
        matched.has(at) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: characters of a fixed string
          <b key={at} className="font-semibold text-(--mint-accent)">
            {char}
          </b>
        ) : (
          char
        ),
      )}
    </span>
  );
}
