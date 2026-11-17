import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  type Command,
  type CommandId,
  commands,
  commandsWithShortcut,
  shortcutOf,
} from "../commands.ts";
import { useT } from "../i18n/index.ts";
import { acceleratorFromEvent, formatAccelerator, sameShortcut } from "../keys.ts";
import type { ShortcutOverrides } from "./schema.ts";
import { useSettings, useSettingsStore } from "./useSettings.ts";

interface ShortcutsSettingsProps {
  /** Told when recording starts and stops: no shortcut may run while one is being recorded. */
  readonly onRecording: (recording: boolean) => void;
}

/** A shortcut that clashes with other commands, waiting for the user to decide. */
interface Conflict {
  readonly accelerator: string;
  readonly with: readonly Command[];
}

const buttonClass =
  "rounded-md border border-(--mint-border) px-2 py-0.5 text-xs hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

/**
 * The `shortcuts` setting: every command with its shortcut, which can be recorded
 * anew, removed or reset to the default. Changes are written to settings.json as
 * overrides of the defaults.
 */
export function ShortcutsSettings({ onRecording }: ShortcutsSettingsProps) {
  const t = useT();
  const headingId = useId();
  const store = useSettingsStore();
  const { shortcuts: overrides } = useSettings().settings;
  const [recording, setRecording] = useState<CommandId | null>(null);

  useEffect(() => onRecording(recording !== null), [onRecording, recording]);
  useEffect(() => () => onRecording(false), [onRecording]);

  const save = (next: ShortcutOverrides) => void store.set("shortcuts", next);

  /** Give `command` the shortcut `accelerator`, taking it away from the commands in `from`. */
  function assign(command: Command, accelerator: string | null, from: readonly Command[] = []) {
    const { [command.id]: _, ...next }: Record<string, string | null> = { ...overrides };
    const isDefault =
      accelerator === null
        ? command.accelerator === undefined
        : command.accelerator !== undefined && sameShortcut(accelerator, command.accelerator);
    if (!isDefault) next[command.id] = accelerator;
    for (const other of from) next[other.id] = null;
    save(next);
  }

  function reset(command: Command) {
    const { [command.id]: _, ...next } = overrides;
    save(next);
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm">
        {t("settings.shortcuts")}
      </h3>
      <div className="flex flex-col divide-y divide-(--mint-border) rounded-md border border-(--mint-border)">
        {(commands as readonly Command[]).map((command) => (
          <ShortcutRow
            key={command.id}
            command={command}
            overrides={overrides}
            recording={recording === command.id}
            onRecord={() => setRecording(command.id)}
            onStopRecording={() => setRecording((id) => (id === command.id ? null : id))}
            onAssign={(accelerator, from) => assign(command, accelerator, from)}
            onReset={() => reset(command)}
          />
        ))}
      </div>
    </section>
  );
}

interface ShortcutRowProps {
  readonly command: Command;
  readonly overrides: ShortcutOverrides;
  readonly recording: boolean;
  readonly onRecord: () => void;
  readonly onStopRecording: () => void;
  readonly onAssign: (accelerator: string | null, from?: readonly Command[]) => void;
  readonly onReset: () => void;
}

function ShortcutRow({
  command,
  overrides,
  recording,
  onRecord,
  onStopRecording,
  onAssign,
  onReset,
}: ShortcutRowProps) {
  const t = useT();
  const title = t(command.title);
  const shortcut = shortcutOf(command, overrides);
  const overridden = Object.hasOwn(overrides, command.id);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const names = (list: readonly Command[]) => list.map((c) => t(c.title)).join(", ");
  // Clashes already in settings.json, e.g. from editing it by hand.
  const clashes = shortcut ? commandsWithShortcut(shortcut, overrides, command.id) : [];

  useEffect(() => {
    if (recording) recorder.current?.focus();
  }, [recording]);

  function onRecorderKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // Nothing the user presses here may reach the editor, the dialog or another shortcut.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      onStopRecording();
      return;
    }
    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) return; // a modifier on its own, or a key that cannot be a shortcut
    onStopRecording();
    const taken = commandsWithShortcut(accelerator, overrides, command.id);
    if (taken.length > 0) setConflict({ accelerator, with: taken });
    else onAssign(accelerator);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and borders that do not fit a list row.
    <div role="group" aria-label={title} className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {recording ? (
          <button
            ref={recorder}
            type="button"
            onKeyDown={onRecorderKeyDown}
            onBlur={onStopRecording}
            className={`${buttonClass} border-(--mint-accent) text-(--mint-accent)`}
          >
            {t("settings.shortcuts.recording")}
          </button>
        ) : (
          <>
            <kbd className="font-sans text-xs text-(--mint-muted)">
              {shortcut ? formatAccelerator(shortcut) : t("settings.shortcuts.none")}
            </kbd>
            <button
              type="button"
              onClick={() => {
                setConflict(null);
                onRecord();
              }}
              className={buttonClass}
            >
              {t("settings.shortcuts.record")}
            </button>
            {shortcut && (
              <button type="button" onClick={() => onAssign(null)} className={buttonClass}>
                {t("settings.shortcuts.remove")}
              </button>
            )}
            {overridden && (
              <button type="button" onClick={onReset} className={buttonClass}>
                {t("settings.shortcuts.reset")}
              </button>
            )}
          </>
        )}
      </div>
      {conflict && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md bg-(--mint-error-bg) px-2 py-1 text-xs text-(--mint-error-fg)"
        >
          <span className="flex-1">
            {t("settings.shortcuts.conflict", {
              shortcut: formatAccelerator(conflict.accelerator),
              commands: names(conflict.with),
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              onAssign(conflict.accelerator, conflict.with);
              setConflict(null);
            }}
            className={buttonClass}
          >
            {t("settings.shortcuts.useAnyway")}
          </button>
          <button type="button" onClick={() => setConflict(null)} className={buttonClass}>
            {t("settings.shortcuts.cancel")}
          </button>
        </div>
      )}
      {!conflict && clashes.length > 0 && (
        <p className="text-xs text-(--mint-error-fg)">
          {t("settings.shortcuts.alsoUsedBy", { commands: names(clashes) })}
        </p>
      )}
    </div>
  );
}
