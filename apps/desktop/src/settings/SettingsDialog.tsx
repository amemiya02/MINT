import { useEffect, useId, useState } from "react";
import { ExternalAgentSettings } from "../ai/ExternalAgentPanel.tsx";
import { ModelConnections } from "../ai/ModelConnections.tsx";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { PluginSettings } from "../plugins/Plugins.tsx";
import { findBuiltinTheme } from "../theme/catalog.ts";
import { ThemeOptions } from "../theme/ThemeOptions.tsx";
import { useTheme } from "../theme/useTheme.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import {
  type SettingDefinition,
  type SettingKey,
  settingsSchema,
  type TextSetting,
} from "./schema.ts";
import { useSettings, useSettingsStore } from "./useSettings.ts";

interface SettingsDialogProps {
  readonly platform: Platform;
  readonly folder: string | null;
  readonly onClose: () => void;
  /** Open settings.json as a document. */
  readonly onOpenFile: (path: string) => void;
  /** Told when a shortcut starts and stops being recorded: no shortcut may run meanwhile. */
  readonly onRecordingShortcut: (recording: boolean) => void;
}

/** The settings window: one control per entry of `settingsSchema`. */
export function SettingsDialog({
  platform,
  folder,
  onClose,
  onOpenFile,
  onRecordingShortcut,
}: SettingsDialogProps) {
  const t = useT();
  const { path } = useSettings();
  const { close, props: dialogProps } = useModalDialog(onClose);
  const titleId = useId();

  return (
    <dialog
      {...dialogProps}
      aria-labelledby={titleId}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-0 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <div className="flex items-center justify-between border-b border-(--mint-border) px-5 py-3">
        <h2 id={titleId} className="text-base font-medium">
          {t("settings.title")}
        </h2>
        <button
          type="button"
          onClick={close}
          className="rounded px-2 py-0.5 text-sm text-(--mint-muted) hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
        >
          {t("settings.close")}
        </button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 py-4">
        <ModelConnections platform={platform} />
        <ExternalAgentSettings platform={platform.externalAgent} />
        <PluginSettings platform={platform} />
        {(Object.keys(settingsSchema) as SettingKey[]).map((key) =>
          settingsSchema[key].kind === "shortcuts" ? (
            <ShortcutsSettings key={key} onRecording={onRecordingShortcut} />
          ) : (
            <SettingControl key={key} settingKey={key} folder={folder} />
          ),
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-(--mint-border) px-5 py-3 text-xs text-(--mint-muted)">
        <span className="truncate" title={path}>
          {t("settings.storedIn", { path })}
        </span>
        <button
          type="button"
          onClick={() => {
            close();
            onOpenFile(path);
          }}
          className="shrink-0 rounded-md border border-(--mint-border) px-3 py-1 text-(--mint-fg) hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
        >
          {t("settings.openFile")}
        </button>
      </div>
    </dialog>
  );
}

const fieldClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

/** The control for one setting, chosen by its kind. */
function SettingControl({
  settingKey,
  folder,
}: {
  readonly settingKey: SettingKey;
  readonly folder: string | null;
}) {
  const t = useT();
  const store = useSettingsStore();
  const { settings } = useSettings();
  const id = useId();
  // Widened on purpose: the control must handle every kind, not just today's settings.
  const definition = settingsSchema[settingKey] as SettingDefinition;
  const value: unknown = settings[settingKey];
  // Each kind's control only produces values of that kind, so this cast is safe.
  const set = (next: unknown) => void store.set(settingKey, next as never);

  let control: React.ReactNode;
  switch (definition.kind) {
    case "choice":
      control = (
        <select
          id={id}
          value={String(value)}
          onChange={(e) => set(e.target.value)}
          className={fieldClass}
        >
          {definition.options.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      );
      break;
    case "folderToggle": {
      if (!folder) return null;
      const folders = value as readonly string[];
      control = (
        <input
          id={id}
          type="checkbox"
          checked={folders.includes(folder)}
          onChange={(e) =>
            set(e.target.checked ? [...folders, folder] : folders.filter((path) => path !== folder))
          }
          className="size-4 accent-(--mint-accent)"
        />
      );
      break;
    }
    case "toggle":
      control = (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => set(e.target.checked)}
          className="size-4 accent-(--mint-accent)"
        />
      );
      break;
    case "number":
      control = (
        <input
          id={id}
          type="number"
          value={Number(value)}
          min={definition.min}
          max={definition.max}
          step={definition.step}
          onChange={(e) => {
            const next = e.target.valueAsNumber;
            if (next >= definition.min && next <= definition.max) set(next);
          }}
          className={`${fieldClass} w-24`}
        />
      );
      break;
    case "text":
      // The Model connections section owns this selector and its live list of saved models.
      if (definition.optionsFrom === "modelConnections") return null;
      control =
        definition.optionsFrom === "themes" ? (
          <ThemeSelect id={id} value={String(value)} onChange={set} />
        ) : (
          <TextField id={id} definition={definition} value={String(value)} onChange={set} />
        );
      break;
    case "shortcuts":
      // A list of its own (see ShortcutsSettings), not a single control.
      return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm">
          {t(definition.label, { folder: folder ?? "" })}
        </label>
        {control}
      </div>
      {definition.kind === "text" && definition.optionsFrom === "themes" && <ThemeFolderHint />}
      {settingKey === "proofreading" && (
        <p className="text-xs text-(--mint-muted)">{t("settings.proofreadingHint")}</p>
      )}
    </div>
  );
}

/** A text field that applies its value when the user is done (Enter or leaving it), not on every keystroke. */
function TextField({
  id,
  definition,
  value,
  onChange,
}: {
  readonly id: string;
  readonly definition: TextSetting;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  // Follow changes made elsewhere (e.g. settings.json edited by hand).
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <input
      id={id}
      type="text"
      value={draft}
      maxLength={definition.maxLength}
      placeholder={definition.placeholder ? t(definition.placeholder) : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className={`${fieldClass} w-56`}
    />
  );
}

/** The built-in themes and every user theme in the theme folder. */
function ThemeSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const { themes } = useTheme();
  const builtin = findBuiltinTheme(value);
  return (
    <select
      id={id}
      value={builtin?.id ?? value}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    >
      <ThemeOptions customThemes={themes} />
      {!builtin && !themes.includes(value) && (
        <option value={value}>{t("settings.theme.missing", { name: value })}</option>
      )}
    </select>
  );
}

function ThemeFolderHint() {
  const t = useT();
  const { folder } = useTheme();
  if (!folder) return null;
  return (
    <p className="truncate text-xs text-(--mint-muted)" title={folder}>
      {t("settings.theme.folder", { path: folder })}
    </p>
  );
}
