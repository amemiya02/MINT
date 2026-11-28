import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import {
  exportWritingSkill,
  importWritingSkill,
  readWritingSkills,
  type SavedWritingSkill,
  saveWritingSkill,
  validWritingSkillDraft,
  type WritingSkillDraft,
  watchWritingSkills,
} from "./saved-writing-skills.ts";
import { WritingSkillDetails, WritingSkillRequirements } from "./WritingSkillPlan.tsx";
import { writingSkillName } from "./writing-skills.ts";

const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const buttonClass =
  "rounded-md border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50";

export function useSavedWritingSkills(platform: Platform) {
  const [skills, setSkills] = useState<Awaited<ReturnType<typeof readWritingSkills>>>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revision = 0;
    const reload = () => {
      const current = ++revision;
      void readWritingSkills(platform).then(
        (next) => {
          if (current !== revision) return;
          setSkills(next);
          setFailed(false);
        },
        () => {
          if (current === revision) setFailed(true);
        },
      );
    };
    reload();
    const stop = watchWritingSkills(reload);
    return () => {
      revision++;
      stop();
    };
  }, [platform]);
  return { skills, failed };
}

export function WritingSkillEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  readonly draft: WritingSkillDraft;
  readonly onChange: (draft: WritingSkillDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly saving: boolean;
}) {
  const t = useT();
  return (
    <fieldset
      className="grid min-w-0 gap-2 rounded border border-(--mint-border) p-2"
      disabled={saving}
    >
      <legend>{t("writing.skill.saveAs")}</legend>
      <label className="grid gap-1">
        {t("writing.skill.name")}
        <input
          className={fieldClass}
          maxLength={100}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1">
        {t("writing.skill.steps")}
        <textarea
          className={fieldClass}
          rows={3}
          maxLength={12_000}
          value={draft.steps}
          onChange={(event) => onChange({ ...draft, steps: event.target.value })}
        />
      </label>
      <label className="grid gap-1">
        {t("writing.skill.result")}
        <textarea
          className={fieldClass}
          rows={2}
          maxLength={4_000}
          value={draft.result}
          onChange={(event) => onChange({ ...draft, result: event.target.value })}
        />
      </label>
      <WritingSkillRequirements draft={draft} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!validWritingSkillDraft(draft)}
          onClick={onSave}
        >
          {t("writing.skill.save")}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          {t("unsaved.cancel")}
        </button>
      </div>
    </fieldset>
  );
}

export function WritingSkillChoices({
  platform,
  skills,
  suggestions,
  onChoose,
  showImport,
}: {
  readonly platform: Platform;
  readonly skills: readonly SavedWritingSkill[];
  readonly suggestions: readonly string[];
  readonly onChoose: (id: string) => void;
  readonly showImport: boolean;
}) {
  const t = useT();
  const [imported, setImported] = useState<WritingSkillDraft>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"importFailed" | "saveFailed">();

  async function pick() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const file = await platform.pickFile(".json,application/json");
      if (file) setImported(await importWritingSkill(file));
    } catch {
      setError("importFailed");
    } finally {
      setPending(false);
    }
  }

  async function save() {
    if (!imported || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await saveWritingSkill(platform, imported);
      setImported(undefined);
    } catch {
      setError("saveFailed");
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset aria-label={t("writing.skill.list")} className="min-w-0 space-y-2" disabled={pending}>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((id) => (
          <button key={id} type="button" className={buttonClass} onClick={() => onChoose(id)}>
            /{id} · {writingSkillName(t, id, skills)}
          </button>
        ))}
        {showImport && !imported && (
          <button type="button" className={buttonClass} onClick={() => void pick()}>
            {t("writing.skill.import")}
          </button>
        )}
      </div>
      {imported && (
        <fieldset className="min-w-0 space-y-2 rounded border border-(--mint-border) p-2">
          <legend>{t("writing.skill.reviewImport")}</legend>
          <WritingSkillDetails draft={imported} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => void save()}>
              {t("writing.skill.save")}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setImported(undefined);
                setError(undefined);
              }}
            >
              {t("unsaved.cancel")}
            </button>
          </div>
        </fieldset>
      )}
      {error && <p role="alert">{t(`writing.skill.${error}`)}</p>}
    </fieldset>
  );
}

export function ExportWritingSkillButton({
  platform,
  skill,
}: {
  readonly platform: Platform;
  readonly skill: SavedWritingSkill;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await exportWritingSkill(platform, skill, t("writing.skill.export"), t("writing.skill.file"));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className={buttonClass} disabled={pending} onClick={() => void save()}>
        {t("writing.skill.export")}
      </button>
      {failed && <p role="alert">{t("writing.skill.exportFailed")}</p>}
    </>
  );
}
