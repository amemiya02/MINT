import type { MintEditor } from "@mint/editor";
import { useLayoutEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";
import { useSettings, useSettingsStore } from "../settings/useSettings.ts";
import type { TabStore } from "../tabs/tab-store.ts";
import { inlineCompletionFor } from "./inline-completion.ts";
import { isLocalModelEndpoint, isLocalModelOffline } from "./model.ts";
import {
  effectiveWritingRecipient,
  loadWritingRecipients,
  type WritingRecipient,
  writingConnectionChoice,
  writingRecipientLabel,
} from "./writing-recipients.ts";

interface CompletionFailure {
  readonly recipient: WritingRecipient;
  readonly alternatives: readonly WritingRecipient[];
  readonly retry: (alternate: WritingRecipient) => void;
}

function completionChoice(settings: Settings) {
  return settings.inlineCompletionModel
    ? writingConnectionChoice(settings, "inlineCompletionModel")
    : null;
}

export function useInlineWritingCompletion(
  platform: Platform,
  store: TabStore,
  tabId: number | null,
  editor: MintEditor | null,
  settingsOpen: boolean,
) {
  const { settings } = useSettings();
  const settingsStore = useSettingsStore();
  const choice = completionChoice(settings);
  const [failure, setFailure] = useState<CompletionFailure>();
  useLayoutEffect(() => {
    if (!editor || choice === null || settingsOpen) return;
    let attached = true;
    const isCurrent = () =>
      attached &&
      store.getState().activeId === tabId &&
      completionChoice(settingsStore.getSnapshot().settings) === choice;
    const unsubscribe = editor.subscribe(({ type }) => {
      if (type === "change" || type === "selection" || type === "compositionEnd") {
        setFailure(undefined);
      }
    });
    void loadWritingRecipients(platform, "readOnly").then(({ available }) => {
      if (!isCurrent()) return;
      const recipient = effectiveWritingRecipient(available, choice);
      if (!recipient) return;
      const send = inlineCompletionFor(platform.sendModelMessage, recipient);
      editor.setInlineCompletion(async (context) => {
        if (!isCurrent()) return null;
        setFailure(undefined);
        try {
          return await send(context);
        } catch (problem) {
          if (
            !context.signal.aborted &&
            isCurrent() &&
            recipient.kind === "model" &&
            isLocalModelOffline(recipient.endpoint, problem)
          ) {
            const { before, after } = context;
            setFailure({
              recipient,
              alternatives: available.filter(
                (item) => item.kind === "model" && !isLocalModelEndpoint(item.endpoint),
              ),
              retry(alternate) {
                setFailure(undefined);
                if (!isCurrent()) return;
                const retry = inlineCompletionFor(platform.sendModelMessage, alternate);
                editor.focus();
                editor.requestInlineCompletion((next) =>
                  isCurrent() && next.before === before && next.after === after
                    ? retry(next)
                    : Promise.resolve(null),
                );
              },
            });
          }
          return null;
        }
      });
    });
    return () => {
      attached = false;
      unsubscribe();
      editor.setInlineCompletion(null);
      setFailure(undefined);
    };
  }, [choice, editor, platform, settingsOpen, settingsStore, store, tabId]);

  return { failure, dismiss: () => setFailure(undefined) };
}

export function InlineCompletionRecovery({
  failure,
  dismiss,
}: {
  readonly failure: CompletionFailure;
  readonly dismiss: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState("");
  const alternate = failure.alternatives.find(({ id }) => id === selected);
  return (
    <section
      aria-label={t("settings.inlineCompletion")}
      className="space-y-1 border-b border-(--mint-border) px-4 py-2 text-sm"
    >
      <p role="status" className="wrap-anywhere">
        {t("writing.localOffline")} {writingRecipientLabel(t, failure.recipient)}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {failure.alternatives.length > 0 && (
          <>
            <label className="grid gap-1">
              {t("writing.task.retryConnection")}
              <select
                className="min-w-0 rounded border border-(--mint-border) bg-(--mint-bg) p-1"
                value={selected}
                onChange={(event) => setSelected(event.currentTarget.value)}
              >
                <option value="">{t("writing.chooseRecipient")}</option>
                {failure.alternatives.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>
                    {writingRecipientLabel(t, recipient)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
              disabled={!alternate}
              onClick={() => alternate && failure.retry(alternate)}
            >
              {t("writing.task.retryOther")}
            </button>
          </>
        )}
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-(--mint-hover)"
          onClick={dismiss}
        >
          {t("settings.close")}
        </button>
      </div>
      {alternate && (
        <p className="wrap-anywhere text-xs text-(--mint-muted)">
          {t("settings.modelRecipient", { address: writingRecipientLabel(t, alternate) })}
        </p>
      )}
    </section>
  );
}
