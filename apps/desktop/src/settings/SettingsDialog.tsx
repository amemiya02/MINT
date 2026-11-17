import { useEffect, useId, useRef } from "react";
import { useT } from "../i18n/index.ts";
import { type SettingDefinition, type SettingKey, settingsSchema } from "./schema.ts";
import { useSettings, useSettingsStore } from "./useSettings.ts";

interface SettingsDialogProps {
  readonly onClose: () => void;
  /** Open settings.json as a document. */
  readonly onOpenFile: (path: string) => void;
}

/** The settings window: one control per entry of `settingsSchema`. */
export function SettingsDialog({ onClose, onOpenFile }: SettingsDialogProps) {
  const t = useT();
  const { path } = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-0 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <div className="flex items-center justify-between border-b border-(--mint-border) px-5 py-3">
        <h2 id={titleId} className="text-base font-medium">
          {t("settings.title")}
        </h2>
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          className="rounded px-2 py-0.5 text-sm text-(--mint-muted) hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
        >
          {t("settings.close")}
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {(Object.keys(settingsSchema) as SettingKey[]).map((key) => (
          <SettingControl key={key} settingKey={key} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-(--mint-border) px-5 py-3 text-xs text-(--mint-muted)">
        <span className="truncate" title={path}>
          {t("settings.storedIn", { path })}
        </span>
        <button
          type="button"
          onClick={() => {
            dialog.current?.close();
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
function SettingControl({ settingKey }: { readonly settingKey: SettingKey }) {
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
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="text-sm">
        {t(definition.label)}
      </label>
      {control}
    </div>
  );
}
