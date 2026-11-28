import type { Annotation, MintEditor, SharedDocument } from "@mint/editor";
import { useEffect, useRef, useState } from "react";
import { isLocalModelOffline } from "../ai/model.ts";
import { ProposedSelectionEdit } from "../ai/ProposedSelectionEdit.tsx";
import {
  effectiveWritingRecipient,
  loadWritingRecipients,
  type WritingRecipient,
  writingConnectionChoice,
  writingRecipientLabel,
} from "../ai/writing-recipients.ts";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useSettings } from "../settings/useSettings.ts";
import type { TabStore } from "../tabs/tab-store.ts";
import {
  type AnnotationResult,
  applyAnnotationEdits,
  batchInstruction,
  batchResults,
  captureAnnotations,
  documentFindings,
  documentReviewInstruction,
} from "./annotation-review.ts";

const buttonClass =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50";
const actions = ["comment", "preview", "direct"] as const;
type ReviewAction = (typeof actions)[number];
type Block = "disk" | "boundaries";
export type AnnotationReviewKind = "batch" | "document";

export function AnnotationReview({
  kind,
  name,
  items,
  unresolved,
  annotations,
  documentId,
  platform,
  store,
  settingsOpen,
  onSettings,
  onResolve,
}: {
  readonly kind: AnnotationReviewKind;
  readonly name: string;
  readonly items: readonly Annotation[];
  readonly unresolved: readonly Annotation[];
  readonly annotations: SharedDocument["annotations"];
  readonly documentId: number;
  readonly platform: Platform;
  readonly store: TabStore;
  readonly settingsOpen: boolean;
  readonly onSettings: () => void;
  readonly onResolve: (id: string) => void;
}) {
  const t = useT();
  const { settings } = useSettings();
  const [recipients, setRecipients] = useState<readonly WritingRecipient[]>([]);
  const [recipientId, setRecipientId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    | "annotationReview.emptyDocument"
    | "annotationReview.invalid"
    | "writing.sendFailed"
    | "writing.localOffline"
    | null
  >(null);
  const [results, setResults] = useState<readonly AnnotationResult[] | null>(null);
  const [findingCount, setFindingCount] = useState<number | null>(null);
  const [action, setAction] = useState<ReviewAction>("preview");
  const [sentAction, setSentAction] = useState<ReviewAction>("preview");
  const [blocked, setBlocked] = useState<Readonly<Partial<Record<string, Block>>>>({});
  const [source, setSource] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  const tracked = useRef<ReturnType<MintEditor["trackRange"]>[]>([]);
  const origin = useRef<{ id: number; editor: MintEditor } | null>(null);
  const isDocument = kind === "document";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const range of tracked.current) range.release();
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) return;
    let current = true;
    setLoading(true);
    void loadWritingRecipients(platform, isDocument ? "readOnly" : undefined).then(
      ({ available, failed }) => {
        if (!current) return;
        setRecipients(available);
        setLoading(false);
        setLoadFailed(failed);
      },
    );
    return () => {
      current = false;
    };
  }, [platform, settingsOpen, isDocument]);

  const available = isDocument
    ? recipients.filter((item) => item.kind === "model" || item.access === "readOnly")
    : recipients;
  const connectionChoice = writingConnectionChoice(settings, "reviewWritingConnection");
  const recipient = recipientId
    ? available.find(({ id }) => id === recipientId)
    : effectiveWritingRecipient(available, connectionChoice);
  function label(candidate: WritingRecipient) {
    return writingRecipientLabel(t, candidate);
  }

  function clearTrackedRanges() {
    for (const range of tracked.current) range.release();
    tracked.current = [];
  }

  async function send() {
    if (!recipient || loading || (!isDocument && !items.length) || running.current) return;
    const { tabs, activeId } = store.getState();
    const tab =
      tabs.find((item) => item.id === activeId && item.documentId === documentId) ??
      tabs.find((item) => item.documentId === documentId);
    const editor = tab && store.editor(tab.id);
    if (!tab || !editor) return;

    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (isDocument) {
        setFindingCount(null);
        const original = editor.getText();
        const selectedText = original.replace(/^\uFEFF/, "");
        if (!selectedText.trim()) {
          setError("annotationReview.emptyDocument");
          return;
        }
        const whole = editor.trackRange({ from: 0, to: original.length });
        try {
          const reply = await recipient.send({
            instruction: documentReviewInstruction,
            selectedText,
          });
          if (!mounted.current || store.editor(tab.id) !== editor) return;
          const entries = documentFindings(reply, editor, original, whole);
          if (entries) {
            annotations.addAll(entries, editor.getText());
            setFindingCount(entries.length);
          } else setError("annotationReview.invalid");
        } finally {
          whole.release();
        }
        return;
      }

      clearTrackedRanges();
      const targets = captureAnnotations(editor, items);
      tracked.current = targets.flatMap(({ range }) => (range ? [range] : []));
      origin.current = { id: tab.id, editor };
      setResults(null);
      setBlocked({});
      const reply = await recipient.send({
        instruction: batchInstruction(action === "comment"),
        annotationBatch: targets.map(({ sent }) => sent),
      });
      if (!mounted.current) return;
      const next = batchResults(reply, targets, action === "comment");
      if (!next) {
        clearTrackedRanges();
        setError("annotationReview.invalid");
        return;
      }
      const edits = next.filter(({ outcome }) => outcome.kind === "edit");
      const applied =
        action === "direct" && edits.length > 0 ? await applyEdits(edits) : new Set<string>();
      if (!mounted.current) return;
      setSentAction(action);
      const completed = next.map((item) =>
        item.outcome.kind === "edit" && applied.has(item.sent.id)
          ? { ...item, outcome: { ...item.outcome, status: "applied" } }
          : item,
      ) satisfies AnnotationResult[];
      tracked.current = completed.flatMap(({ range, outcome }) => {
        if (!range) return [];
        if (outcome.kind === "edit" && outcome.status === "preview") return [range];
        range.release();
        return [];
      });
      setResults(completed);
    } catch (problem) {
      if (!isDocument) clearTrackedRanges();
      if (mounted.current) {
        setError(
          recipient.kind === "model" && isLocalModelOffline(recipient.endpoint, problem)
            ? "writing.localOffline"
            : "writing.sendFailed",
        );
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function applyEdits(items: readonly AnnotationResult[]): Promise<ReadonlySet<string>> {
    const target = origin.current;
    const ready = !!target && (await store.refreshDisk(target.id));
    const applied =
      mounted.current && target && ready && store.editor(target.id) === target.editor
        ? applyAnnotationEdits(target.editor, items)
        : new Set<string>();
    if (mounted.current) {
      setBlocked((previous) => ({
        ...previous,
        ...Object.fromEntries(
          items.map(({ sent: { id } }) => [
            id,
            applied.has(id) ? undefined : ready ? "boundaries" : "disk",
          ]),
        ),
      }));
    }
    return applied;
  }

  function decide(item: AnnotationResult, status: "applied" | "discarded") {
    item.range?.release();
    tracked.current = tracked.current.filter((range) => range !== item.range);
    setResults(
      (previous) =>
        previous?.map((entry) =>
          entry === item && entry.outcome.kind === "edit"
            ? { ...entry, outcome: { ...entry.outcome, status } }
            : entry,
        ) ?? null,
    );
  }

  async function apply(item: AnnotationResult) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      if ((await applyEdits([item])).has(item.sent.id) && mounted.current) decide(item, "applied");
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const scope = isDocument
    ? t("writing.scope.document")
    : t("annotationReview.scope", { count: String(items.length) });
  const appliedCount =
    results?.filter(({ outcome }) => outcome.kind === "edit" && outcome.status === "applied")
      .length ?? 0;
  return (
    <div className="mt-3 space-y-3 border-t border-(--mint-border) pt-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <p>
          {isDocument
            ? t("annotationReview.documentContext", { name })
            : t("annotationReview.context", { scope })}
        </p>
        {!isDocument && (
          <label className="grid gap-1">
            {t("writing.action")}
            <select
              className="min-w-0 rounded border border-(--mint-border) bg-(--mint-bg) p-1"
              value={action}
              disabled={busy}
              onChange={(event) => setAction(event.currentTarget.value as ReviewAction)}
            >
              {actions.map((value) => (
                <option key={value} value={value}>
                  {t(`writing.${value}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1">
          {t("writing.recipient")}
          <select
            className="min-w-0 rounded border border-(--mint-border) bg-(--mint-bg) p-1"
            value={recipient?.id ?? ""}
            disabled={loading || busy}
            onChange={(event) => setRecipientId(event.currentTarget.value)}
          >
            {!recipient && (
              <option value="">
                {t(
                  loading
                    ? "writing.loading"
                    : connectionChoice || recipientId
                      ? "settings.modelUnavailable"
                      : "writing.chooseRecipient",
                )}
              </option>
            )}
            {available.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {label(candidate)}
              </option>
            ))}
          </select>
        </label>
        {isDocument && !loading && !recipient && (
          <p className="text-xs text-(--mint-muted)">{t("annotationReview.documentConnection")}</p>
        )}
        {recipient?.kind === "agent" && (
          <p className="text-xs text-(--mint-muted)">
            {t("agent.processAccess")}{" "}
            {t(recipient.access === "readOnly" ? "agent.readOnlyAccess" : "agent.configuredAccess")}{" "}
            {t("agent.tools")} {t("agent.usesLogin")}
          </p>
        )}
        {loadFailed && <p role="alert">{t("writing.connectionsFailed")}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={buttonClass}
            disabled={!recipient || (!isDocument && !items.length) || loading || busy}
          >
            {recipient
              ? t("writing.sendAuthorized", {
                  action: t(`writing.${isDocument ? "comment" : action}`),
                  scope,
                  recipient: label(recipient),
                })
              : t("writing.send")}
          </button>
          <button type="button" className={buttonClass} onClick={onSettings}>
            {t("writing.manage")}
          </button>
        </div>
        {busy && <p role="status">{t("annotationReview.working")}</p>}
        {error && <p role="alert">{t(error)}</p>}
      </form>
      {isDocument && findingCount !== null && (
        <p role="status">
          {findingCount === 0
            ? t("annotationReview.noFindings")
            : t("annotationReview.findings", { count: String(findingCount) })}
        </p>
      )}
      {!isDocument && results && (
        <section aria-label={t("annotationReview.results")} className="space-y-2">
          <h3 className="font-medium">{t("annotationReview.results")}</h3>
          {sentAction === "direct" && (
            <p role="status">
              {appliedCount === 1
                ? t("annotationReview.appliedOne")
                : t("annotationReview.applied", { count: String(appliedCount) })}
            </p>
          )}
          {results.some(({ outcome }) => outcome.kind === "edit") && (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={source}
                onChange={(event) => setSource(event.currentTarget.checked)}
              />
              {t("writing.edit.source")}
            </label>
          )}
          <ol className="space-y-2">
            {results.map((item, index) => {
              const { sent, outcome } = item;
              return (
                <li key={sent.id} className="space-y-1 border-t border-(--mint-border) py-2">
                  <blockquote className="whitespace-pre-wrap wrap-anywhere text-(--mint-muted)">
                    {sent.excerpt || t("annotations.emptyCell")}
                  </blockquote>
                  <p className="whitespace-pre-wrap wrap-anywhere">{sent.note}</p>
                  {outcome.kind === "reply" && (
                    <>
                      <p className="whitespace-pre-wrap wrap-anywhere">{outcome.text}</p>
                      {unresolved.some(({ id }) => id === sent.id) && (
                        <button
                          type="button"
                          className={buttonClass}
                          onClick={() => onResolve(sent.id)}
                        >
                          {t("annotations.resolve")}
                        </button>
                      )}
                    </>
                  )}
                  {outcome.kind === "missing" && (
                    <p className="whitespace-pre-wrap wrap-anywhere">
                      {t("annotationReview.missing", { material: outcome.text })}
                    </p>
                  )}
                  {outcome.kind === "unanswered" && <p>{t("annotationReview.unanswered")}</p>}
                  {outcome.kind === "edit" && (
                    <ProposedSelectionEdit
                      before={sent.excerpt}
                      after={outcome.text}
                      label={t("writing.edit.position", {
                        index: String(index + 1),
                        total: String(results.length),
                      })}
                      status={outcome.status}
                      source={source}
                      blocked={blocked[sent.id] ?? (item.range ? undefined : "boundaries")}
                      busy={busy}
                      onApply={
                        outcome.status === "preview" && item.range
                          ? () => void apply(item)
                          : undefined
                      }
                      onDiscard={
                        outcome.status === "preview" ? () => decide(item, "discarded") : undefined
                      }
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
