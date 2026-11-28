import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { type Command, type CommandId, commands, shortcutOf } from "../commands.ts";
import { useT } from "../i18n/index.ts";
import { ariaKeyShortcut, formatAccelerator } from "../keys.ts";
import { useInstallations } from "../plugins/Plugins.tsx";
import { type FuzzyMatch, fuzzyMatch } from "../quick-open/fuzzy.ts";
import { useSettings } from "../settings/useSettings.ts";
import { useModalDialog } from "../window/useModalDialog.ts";

export interface CommandPaletteProps {
  /** Run the chosen command; called after the palette has closed. */
  readonly onRun: (id: CommandId) => void;
  readonly onTemplate: (id: string, name: string) => void;
  readonly onClose: () => void;
}

interface Result {
  readonly id: string;
  readonly run: () => void;
  readonly accelerator?: string | undefined;
  readonly title: string;
  readonly match: FuzzyMatch;
}

/** Command palette: fuzzy-search every registered command by name and run one. */
export function CommandPalette({ onRun, onTemplate, onClose }: CommandPaletteProps) {
  const t = useT();
  const plugins = useInstallations();
  const { shortcuts } = useSettings().settings;
  const { close, props: dialogProps } = useModalDialog(onClose);
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
      if (match)
        found.push({
          id: command.id,
          title,
          match,
          accelerator: shortcutOf(command, shortcuts),
          run: () => onRun(command.id),
        });
    }
    for (const { enabled, manifest } of plugins) {
      if (!enabled || !("templates" in manifest)) continue;
      for (const template of manifest.templates) {
        const title = t("plugin.insertTemplate", { name: template.name });
        const match = fuzzyMatch(query, title);
        if (match)
          found.push({
            id: `plugin:${manifest.id}:${template.name}`,
            title,
            match,
            run: () => onTemplate(manifest.id, template.name),
          });
      }
    }
    // Registry order without a query; best match first with one.
    return query.trim() === "" ? found : found.sort((a, b) => b.match.score - a.match.score);
  }, [t, query, onRun, onTemplate, plugins, shortcuts]);
  const current = Math.min(selected, results.length - 1);

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current]);

  function choose(result: Result | undefined) {
    if (!result) return;
    close();
    result.run();
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
      {...dialogProps}
      aria-label={t("commandPalette.title")}
      onMouseDown={(event) => {
        // A click on the backdrop dismisses the palette.
        if (event.target === event.currentTarget) close();
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
          const { accelerator } = result;
          return (
            <div
              key={result.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              aria-keyshortcuts={accelerator ? ariaKeyShortcut(accelerator) : undefined}
              data-command={result.id}
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
