import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import {
  type AppliedWritingPreference,
  preferenceKey,
  readWritingPreferences,
  resolveWritingPreferences,
  type StoredWritingPreference,
  type WritingPreference,
  type WritingPreferenceScope,
  writingPreferencesFile,
} from "./writing-preferences.ts";

type Snapshot = readonly StoredWritingPreference[] | "loading" | "failed";

function createStore(platform: Platform) {
  let snapshot: Snapshot = "loading";
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    async refresh() {
      const current = ++revision;
      let next: Snapshot;
      try {
        next = readWritingPreferences(await platform.readAppData(writingPreferencesFile));
      } catch {
        next = "failed";
      }
      if (current !== revision) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

const stores = new WeakMap<Platform, ReturnType<typeof createStore>>();
const subscribeEmpty = () => () => {};
const emptySnapshot: Snapshot = [];
const getEmpty = () => emptySnapshot;
const noTaskPreferences: readonly WritingPreference[] = [];

export function useWritingPreferences(
  platform: Platform | undefined,
  folder: string | null,
  initial = noTaskPreferences,
) {
  let store = platform && stores.get(platform);
  if (platform && !store) {
    store = createStore(platform);
    stores.set(platform, store);
  }
  const saved = useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getSnapshot ?? getEmpty,
  );
  const [task, setTask] = useState(initial);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!store) return;
    const refresh = () => void store.refresh();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [store]);

  const applied = resolveWritingPreferences(typeof saved === "string" ? [] : saved, folder, task);
  return {
    folder,
    task,
    request: applied.length ? applied : undefined,
    available: saved !== "loading" && !saving,
    loadFailed: saved === "failed",
    applied,
    async remember(scope: WritingPreferenceScope, preference: WritingPreference) {
      const key = preferenceKey(preference.topic);
      if (scope === "task") {
        setTask((current) => [
          ...current.filter(({ topic }) => preferenceKey(topic) !== key),
          preference,
        ]);
        return;
      }
      if (!platform || !store || savingRef.current || (scope === "folder" && !folder)) return;
      savingRef.current = true;
      setSaving(true);
      try {
        await platform.saveWritingPreference({
          ...preference,
          key,
          folder: scope === "folder" ? folder : null,
        });
        await store.refresh();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
  };
}

const field = "w-full rounded border border-(--mint-border) bg-(--mint-bg) px-2 py-1";
const button =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50";

export function AppliedWritingPreferences({
  preferences,
}: {
  readonly preferences: readonly AppliedWritingPreference[];
}) {
  const t = useT();
  if (!preferences.length) return null;
  return (
    <ul className="space-y-1">
      {preferences.map(({ topic, guidance, scope }) => (
        <li key={preferenceKey(topic)} className="wrap-anywhere">
          <span className="font-medium">{topic}</span> · {t(`writing.preference.${scope}`)}
          <p className="whitespace-pre-wrap">{guidance}</p>
        </li>
      ))}
    </ul>
  );
}

export function WritingPreferences({
  preferences,
  openRequest,
  correction,
  disabled,
}: {
  readonly preferences: ReturnType<typeof useWritingPreferences>;
  readonly openRequest?: object | null;
  readonly correction?: string;
  readonly disabled?: boolean;
}) {
  const t = useT();
  const editor = useRef<HTMLDetailsElement>(null);
  const topicInput = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<WritingPreferenceScope>("task");
  const [topic, setTopic] = useState("");
  const [guidance, setGuidance] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const selectedScope = scope === "folder" && !preferences.folder ? "task" : scope;

  useEffect(() => {
    if (!openRequest || !editor.current) return;
    editor.current.open = true;
    topicInput.current?.focus();
  }, [openRequest]);

  async function remember() {
    if (!topic.trim() || !guidance.trim() || !preferences.available) return;
    setSaveFailed(false);
    try {
      await preferences.remember(selectedScope, { topic: topic.trim(), guidance: guidance.trim() });
      setTopic("");
      setGuidance("");
      if (editor.current) {
        editor.current.open = false;
        editor.current.querySelector("summary")?.focus();
      }
    } catch {
      setSaveFailed(true);
    }
  }

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-1 rounded border border-(--mint-border) p-2 text-xs"
    >
      <legend className="px-1">{t("writing.preference.toSend")}</legend>
      {preferences.loadFailed && <p role="alert">{t("writing.preference.loadFailed")}</p>}
      <AppliedWritingPreferences preferences={preferences.applied} />
      <details
        ref={editor}
        className="space-y-2"
        onToggle={(event) => {
          if (event.currentTarget.open && correction)
            setGuidance((current) => current || correction.trim());
        }}
      >
        <summary className="cursor-pointer">{t("writing.preference.remember")}</summary>
        <p className="text-(--mint-muted)">{t("writing.preference.priority")}</p>
        <label className="block">
          {t("writing.preference.scope")}
          <select
            className={field}
            value={selectedScope}
            onChange={(event) => setScope(event.target.value as WritingPreferenceScope)}
          >
            <option value="task">{t("writing.preference.task")}</option>
            {preferences.folder && <option value="folder">{t("writing.preference.folder")}</option>}
            <option value="personal">{t("writing.preference.personal")}</option>
          </select>
        </label>
        <label className="block">
          {t("writing.preference.topic")}
          <input
            ref={topicInput}
            className={field}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </label>
        <label className="block">
          {t("writing.preference.guidance")}
          <textarea
            rows={2}
            className={field}
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
          />
        </label>
        {saveFailed && <p role="alert">{t("writing.preference.saveFailed")}</p>}
        <button
          type="button"
          className={button}
          disabled={!topic.trim() || !guidance.trim() || !preferences.available}
          onClick={() => void remember()}
        >
          {t("writing.preference.save")}
        </button>
      </details>
    </fieldset>
  );
}
