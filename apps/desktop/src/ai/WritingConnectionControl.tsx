import { useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { settingsSchema } from "../settings/schema.ts";
import { useSettings, useSettingsStore } from "../settings/useSettings.ts";
import { ExternalAgentAccessNotice } from "./ExternalAgentPanel.tsx";
import { inlineCompletionFor } from "./inline-completion.ts";
import {
  effectiveWritingRecipient,
  inheritWritingConnection,
  type WritingConnectionSetting,
  type WritingRecipient,
  writingConnectionChoice,
  writingConnectionId,
  writingRecipientLabel,
} from "./writing-recipients.ts";

const field =
  "max-w-[55%] truncate rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

export function WritingConnectionControl({
  setting,
  platform,
  available,
}: {
  readonly setting: WritingConnectionSetting;
  readonly platform: Platform;
  readonly available: readonly WritingRecipient[] | null;
}) {
  const id = useId();
  const t = useT();
  const store = useSettingsStore();
  const { settings } = useSettings();
  const saved = settings[setting];
  const completion = setting === "inlineCompletionModel";
  const inherited = setting !== "defaultWritingConnection";
  const off = completion && saved === "";
  const recipient =
    !off && available
      ? effectiveWritingRecipient(available, writingConnectionChoice(settings, setting))
      : undefined;
  const chosen = saved && effectiveWritingRecipient(available ?? [], saved);
  const value = chosen ? writingConnectionId(chosen) : saved;
  return (
    <fieldset className="min-w-0 space-y-1">
      <legend className="sr-only">{t(settingsSchema[setting].label)}</legend>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm">
          {t(settingsSchema[setting].label)}
        </label>
        <select
          id={id}
          className={field}
          disabled={!available}
          value={value}
          onChange={(event) => void store.set(setting, event.currentTarget.value)}
        >
          <option value="">
            {t(
              completion
                ? "settings.inlineCompletion.off"
                : inherited
                  ? "settings.writingConnection.inherit"
                  : "settings.writingConnection.automatic",
            )}
          </option>
          {completion && (
            <option value={inheritWritingConnection}>
              {t("settings.writingConnection.inherit")}
            </option>
          )}
          {available?.map((candidate) => (
            <option key={candidate.id} value={writingConnectionId(candidate)}>
              {candidate.kind === "model" ? candidate.name : candidate.path}
            </option>
          ))}
          {saved && saved !== inheritWritingConnection && !chosen && (
            <option value={saved} disabled>
              {t("settings.modelUnavailable")}
            </option>
          )}
        </select>
      </div>
      {completion && (
        <p className="text-xs text-(--mint-muted)">{t("settings.inlineCompletion.hint")}</p>
      )}
      {recipient ? (
        <>
          <p className="wrap-anywhere text-xs text-(--mint-muted)">
            {t("settings.modelRecipient", { address: writingRecipientLabel(t, recipient) })}
          </p>
          {recipient.kind === "agent" && (
            <details className="text-xs text-(--mint-muted)">
              <summary>{t("agent.access")}</summary>
              <ExternalAgentAccessNotice access={recipient.access} />
            </details>
          )}
          <ConnectionSample
            key={recipient.id}
            completion={completion}
            platform={platform}
            recipient={recipient}
          />
        </>
      ) : (
        !off &&
        available && <p className="text-xs text-(--mint-muted)">{t("settings.modelUnavailable")}</p>
      )}
    </fieldset>
  );
}

function ConnectionSample({
  completion,
  platform,
  recipient,
}: {
  readonly completion: boolean;
  readonly platform: Platform;
  readonly recipient: WritingRecipient;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ text: string; error?: true }>();
  const before = t("settings.writingConnection.completionSample");
  const sample = completion ? before : t("agent.sampleText");

  async function run() {
    setWorking(true);
    setResult(undefined);
    try {
      const text = completion
        ? await inlineCompletionFor(
            platform.sendModelMessage,
            recipient,
          )({
            before,
            after: "",
            signal: new AbortController().signal,
          })
        : (
            await recipient.send({
              instruction: t("agent.sampleInstruction"),
              selectedText: sample,
            })
          ).text;
      if (!text?.trim()) throw "invalidReply";
      setResult({ text });
    } catch {
      setResult({ text: t("writing.sendFailed"), error: true });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-1 text-xs">
      <p className="text-(--mint-muted)">
        {t("settings.writingConnection.sample", { text: sample })}
      </p>
      <button
        type="button"
        className="rounded-md border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
        disabled={working}
        onClick={() => void run()}
      >
        {t(working ? "models.running" : "models.run")}
      </button>
      {result && (
        <p role={result.error ? "alert" : "status"} className="whitespace-pre-wrap wrap-anywhere">
          {result.text}
        </p>
      )}
    </div>
  );
}
