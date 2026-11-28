import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import {
  type WritingAction,
  type WritingSkillId,
  writingActions,
  writingSkillResult,
  writingSkillSteps,
} from "./writing-skills.ts";

const preferenceChanges = new EventTarget();

async function preferenceFile(folder: string, skill: WritingSkillId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(folder));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `writing-skill-${skill}-${key.join("")}.json`;
}

export function useWritingSkillAction(
  platform: Platform,
  folder: string | null,
  id?: WritingSkillId,
) {
  const key = folder && id ? JSON.stringify([folder, id]) : null;
  const [saved, setSaved] = useState<{
    key: string;
    action?: WritingAction;
    failed?: boolean;
  }>();
  const [saving, setSaving] = useState(false);
  const preference = saved?.key === key ? saved : undefined;

  useEffect(() => {
    if (!key || !folder || !id) return;
    let revision = 0;
    const reload = () => {
      const current = ++revision;
      setSaved((previous) => (previous?.key === key ? undefined : previous));
      void preferenceFile(folder, id)
        .then((file) => platform.readAppData(file))
        .then(
          (text) => {
            if (current !== revision) return;
            const action = writingActions.find((action) => JSON.stringify(action) === text);
            setSaved({ key, action });
          },
          () => {
            if (current === revision) setSaved({ key, failed: true });
          },
        );
    };
    reload();
    preferenceChanges.addEventListener(key, reload);
    window.addEventListener("focus", reload);
    return () => {
      revision++;
      preferenceChanges.removeEventListener(key, reload);
      window.removeEventListener("focus", reload);
    };
  }, [platform, key, folder, id]);

  return {
    action: preference?.action,
    loading: !!key && !preference,
    saving,
    failed: preference?.failed,
    async remember(action: WritingAction) {
      if (!key || !folder || !id || saving || !preference) return;
      setSaving(true);
      try {
        await platform.writeAppData(await preferenceFile(folder, id), JSON.stringify(action));
        preferenceChanges.dispatchEvent(new Event(key));
      } catch {
        setSaved((previous) => (previous?.key === key ? { ...previous, failed: true } : previous));
      } finally {
        setSaving(false);
      }
    },
  };
}

export function WritingSkillPlan({
  id,
  folder,
  action,
  preference,
}: {
  readonly id: WritingSkillId;
  readonly folder: string | null;
  readonly action: WritingAction;
  readonly preference: ReturnType<typeof useWritingSkillAction>;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-2 rounded border border-(--mint-border) p-2 text-xs">
      <legend className="px-1">{t("writing.skill.plan")}</legend>
      <p className="font-medium">{t(`writing.skill.${id}`)}</p>
      <ol className="list-decimal space-y-1 pl-5">
        {writingSkillSteps(t, id).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p>{t("writing.skill.preserve")}</p>
      <p>{writingSkillResult(t, action)}</p>
      <p>{t("writing.skill.noTools")}</p>
      {folder && (
        <div className="space-y-1 border-t border-(--mint-border) pt-2 wrap-anywhere">
          {preference.loading ? (
            <p role="status">{t("writing.skill.loading")}</p>
          ) : (
            <>
              {preference.action ? (
                <p role="status">
                  {t("writing.skill.remembered", {
                    folder,
                    action: t(`writing.${preference.action}`),
                  })}
                </p>
              ) : (
                !preference.failed && <p>{t("writing.skill.noRemembered", { folder })}</p>
              )}
              {preference.failed && <p role="alert">{t("writing.skill.preferenceFailed")}</p>}
              <button
                type="button"
                className="rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
                disabled={preference.saving || (action === preference.action && !preference.failed)}
                onClick={() => void preference.remember(action)}
              >
                {t("writing.skill.remember", { folder })}
              </button>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
