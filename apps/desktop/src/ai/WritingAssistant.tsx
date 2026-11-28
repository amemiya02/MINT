import type { MintEditor } from "@mint/editor";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useTabStore } from "../tabs/context.ts";
import { type EditStatus, ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import { ReplyExcerpt } from "./ReplyExcerpt.tsx";
import { type SelectionEdit, selectionEdits } from "./selection-edits.ts";
import { loadWritingRecipients, type WritingRecipient } from "./writing-recipients.ts";
import {
  applyWritingSelection,
  captureWritingSelection,
  type WritingSelection,
} from "./writing-selection.ts";
import { failureStatus, replyStatus, type AttemptStatus } from "./writing-attempt.ts";
import { replacementFromReply, splitWritingProgress, type WritingRequest, type WritingTurn } from "./writing-sender.ts";
import { useWritingTask } from "./WritingTasks.tsx";

const buttonClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

const scopes = ["selection", "document", "instruction"] as const;
type Scope = (typeof scopes)[number];
const actions = ["comment", "preview", "direct"] as const;
type Action = (typeof actions)[number];

interface Origin extends WritingSelection {
  readonly id: number;
}

interface Task {
  readonly request: WritingRequest;
  readonly action: Action;
  readonly scope: Scope;
  readonly seen: Set<string>;
}

interface Attempt {
  readonly task: Task;
  readonly recipientId: string;
  readonly recipient: string;
  readonly status: AttemptStatus;
  readonly partial: string;
}

interface Turn extends WritingTurn {
  readonly status?: AttemptStatus;
  readonly partial?: string;
  readonly material?: string;
  readonly recipient: string;
  readonly recipientId: string;
  readonly appliedDirectly?: boolean;
  readonly suggestions?: readonly Suggestion[];
}

type TrackedRange = ReturnType<Origin["range"]["trackSubrange"]>;
type Suggestion = Pick<SelectionEdit, "before" | "after"> & {
  readonly id: number;
  readonly range: TrackedRange;
  readonly status: EditStatus;
  readonly comments?: readonly (WritingTurn & { readonly id: number })[];
};

interface Props {
  readonly editor: MintEditor | null;
  readonly tabId: number;
  readonly name: string;
  readonly active: boolean;
  readonly platform: Platform;
  readonly askRequest: number | null;
  readonly settingsOpen: boolean;
  readonly onAsk: () => void;
  readonly onSettings: () => void;
  readonly externalChange: boolean;
  readonly refreshDisk: () => Promise<boolean>;
  readonly children: ReactNode;
}

/** The editor owns its selection and scroll position, while the composer retains the task material. */
export function WritingAssistant({
  editor,
  tabId,
  name,
  active,
  platform,
  askRequest,
  settingsOpen,
  onAsk,
  onSettings,
  externalChange,
  refreshDisk,
  children,
}: Props) {
  const t = useT();
  const [hasSelection, setHasSelection] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const taskRunning = useRef(false);
  const [placement, setPlacement] = useState<"inline" | "sidebar" | null>(null);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const { anchor, head } = editor.getSelection();
      setHasSelection(anchor !== head);
    };
    refresh();
    return editor.subscribe((event) => {
      if (event.type === "selection" || event.type === "change") refresh();
    });
  }, [editor]);

  useEffect(() => {
    if (!askRequest || !editor) return;
    if (taskRunning.current) {
      setPlacement("sidebar");
      return;
    }
    const selection = captureWritingSelection(editor);
    if (!selection) return;
    setOrigin({ id: askRequest, ...selection });
    setPlacement("inline");
  }, [askRequest, editor]);

  useEffect(() => () => origin?.range.release(), [origin]);

  return (
    <div
      className={`relative grid min-h-0 min-w-0 flex-1 ${
        placement === "sidebar"
          ? "grid-rows-[minmax(0,1fr)_minmax(0,45%)] md:grid-cols-[minmax(0,1fr)_min(22rem,45%)] md:grid-rows-1"
          : "grid-rows-1"
      }`}
    >
      <div className="min-h-0 min-w-0">{children}</div>
      {!placement && active && (hasSelection || origin) && (
        <div className="absolute right-4 bottom-4 z-10 flex gap-2">
          {origin && (
            <button type="button" className={buttonClass} onClick={() => setPlacement("inline")}>
              {t("writing.resume")}
            </button>
          )}
          {hasSelection && (
            <button type="button" className={buttonClass} onClick={onAsk}>
              {t("writing.ask")}
            </button>
          )}
        </div>
      )}
      {origin && origin.editor === editor && (
        <Composer
          key={origin.id}
          origin={origin}
          tabId={tabId}
          name={name}
          placement={placement}
          setPlacement={setPlacement}
          active={active}
          taskRunning={taskRunning}
          platform={platform}
          settingsOpen={settingsOpen}
          onSettings={onSettings}
          externalChange={externalChange}
          refreshDisk={refreshDisk}
        />
      )}
    </div>
  );
}

function Composer({
  origin,
  tabId,
  name,
  placement,
  setPlacement,
  taskRunning,
  active,
  platform,
  settingsOpen,
  onSettings,
  externalChange,
  refreshDisk,
}: Pick<
  Props,
  | "tabId"
  | "name"
  | "active"
  | "platform"
  | "settingsOpen"
  | "onSettings"
  | "externalChange"
  | "refreshDisk"
> & {
  readonly origin: Origin;
  readonly placement: "inline" | "sidebar" | null;
  readonly taskRunning: { current: boolean };
  readonly setPlacement: (placement: "inline" | "sidebar" | null) => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<Scope>("selection");
  const [actionOverride, setActionOverride] = useState<Action | null>(null);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [recipients, setRecipients] = useState<readonly WritingRecipient[]>([]);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [rewriting, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [retryId, setRetryId] = useState("");
  const controller = useRef<AbortController | null>(null);
  const busy = attempt?.status === "working" || rewriting;
  const store = useTabStore();
  const [error, setError] = useState<"sendFailed" | "agentChanged" | "missingSelection" | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const isActive = useRef(active);
  isActive.current = active;
  const checkingDisk = useRef(false);
  const trackedSuggestions = useRef(new Set<TrackedRange>());
  const [showSource, setShowSource] = useState(false);
  const [draft, setDraft] = useState(() => origin.editor.getText());
  const recipient = recipients.find((candidate) => candidate.id === recipientId);
  const labelFor = (candidate: WritingRecipient) =>
    candidate.kind === "agent"
      ? t("writing.recipient.agent", { path: candidate.path })
      : t("writing.recipient.model", { name: candidate.name, endpoint: candidate.endpoint });
  const material =
    scope === "selection"
      ? origin.text
      : scope === "document"
        ? draft.replace(/^\uFEFF/, "")
        : undefined;
  const explicitDirect = /(?:^|[,，]\s*)(?:apply directly|直接改)[.!。！]?\s*$/i.test(instruction);
  const action =
    scope !== "selection"
      ? "comment"
      : (actionOverride ?? (explicitDirect ? "direct" : turns.length ? "comment" : "preview"));

  useEffect(() => {
    mounted.current = true;
    const tracked = trackedSuggestions.current;
    return () => {
      mounted.current = false;
      taskRunning.current = false;
      controller.current?.abort();
      for (const range of tracked) range.release();
      tracked.clear();
    };
  }, [taskRunning]);

  useEffect(() => {
    const refresh = () => setDraft(origin.editor.getText());
    refresh();
    return origin.editor.subscribe((event) => {
      if (event.type === "change") refresh();
    });
  }, [origin]);

  useEffect(() => {
    if (settingsOpen) return;
    let current = true;
    setLoading(true);
    setLoadFailed(false);
    void loadWritingRecipients(platform).then(({ available, failed }) => {
      if (!current) return;
      setRecipients(available);
      setRecipientId((previous) => previous ?? available[0]?.id ?? null);
      setLoadFailed(failed);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [platform, settingsOpen]);

  useEffect(() => {
    if (placement && active && !settingsOpen) input.current?.focus();
  }, [placement, active, settingsOpen]);

  function close() {
    setPlacement(null);
    origin.editor.focus();
  }

  function locate() {
    const { from, to } = origin.range.current();
    if (from === to) {
      setError("missingSelection");
      return;
    }
    origin.editor.setSelection({ anchor: from, head: to, scrollIntoView: true });
    origin.editor.focus();
  }

  async function applyDirectly(replacement: string, signal: AbortSignal): Promise<boolean> {
    return (
      (await refreshDisk()) &&
      mounted.current &&
      !signal.aborted &&
      applyWritingSelection(origin, replacement, true).status === "applied"
    );
  }

  function preview(edits: SelectionEdit[]): Suggestion[] {
    return edits.map((edit) => {
      const range = origin.range.trackSubrange(edit);
      trackedSuggestions.current.add(range);
      return { id: edit.from, before: edit.before, after: edit.after, range, status: "preview" };
    });
  }

  function updateSuggestion(index: number, position: number, update: Partial<Suggestion>) {
    setTurns((previous) =>
      previous.map((turn, i) =>
        i === index
          ? {
              ...turn,
              suggestions: turn.suggestions?.map((item, j) =>
                j === position ? { ...item, ...update } : item,
              ),
            }
          : turn,
      ),
    );
  }

  async function decide(
    index: number,
    position: number,
    suggestion: Suggestion,
    acceptedText?: string,
  ) {
    if (busy || checkingDisk.current || suggestion.status !== "preview") return;
    if (acceptedText !== undefined) {
      checkingDisk.current = true;
      try {
        if (!(await refreshDisk()) || !mounted.current || !suggestion.range.hasBoundaries()) return;
        const range = suggestion.range.current();
        if (origin.editor.getText().slice(range.from, range.to) !== acceptedText) return;
        if (acceptedText !== suggestion.after) origin.editor.replaceRange(range, suggestion.after);
        if (isActive.current) origin.editor.focus();
      } finally {
        checkingDisk.current = false;
      }
    }
    const status = acceptedText === undefined ? "discarded" : "applied";
    if (trackedSuggestions.current.delete(suggestion.range)) {
      suggestion.range.release();
    }
    updateSuggestion(index, position, { status });
  }

  function reportSendError(problem: unknown) {
    const code = problem instanceof Error ? problem.message : problem;
    setError(
      code === "agentAccessRequired" || code === "agentChanged" ? "agentChanged" : "sendFailed",
    );
  }

  async function rewrite(
    index: number,
    position: number,
    turn: Turn,
    suggestion: Suggestion,
    current: string,
    prompt: string,
  ) {
    const connection = recipients.find(({ id }) => id === turn.recipientId);
    if (!connection || busy || checkingDisk.current || !suggestion.range.hasBoundaries())
      return false;
    const { from, to } = suggestion.range.current();
    if (origin.editor.getText().slice(from, to) !== current) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await connection.send({
        instruction: prompt,
        selectedText: current,
        history: [{ instruction: turn.instruction, reply: suggestion.after }],
        responseFormat: "replacement",
      });
      if (!mounted.current) return false;
      const replacement = replacementFromReply(result);
      const comments = suggestion.comments ?? [];
      updateSuggestion(
        index,
        position,
        replacement === undefined
          ? {
              comments: [
                ...comments,
                { id: comments.length, instruction: prompt, reply: result.text },
              ],
            }
          : { before: current, after: replacement },
      );
      return true;
    } catch (problem) {
      if (mounted.current) reportSendError(problem);
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!instruction.trim() || !recipient || busy || loading || checkingDisk.current) return;
    const history = includeHistory
      ? turns.flatMap(({ status, instruction, reply, suggestions }) => [
          ...(status === "complete" && reply ? [{ instruction, reply }] : []),
          ...(suggestions?.flatMap(
            ({ comments }) =>
              comments?.map(({ instruction, reply }) => ({ instruction, reply })) ?? [],
          ) ?? []),
        ])
      : [];
    const task: Task = {
      request: {
        instruction: instruction.trim(),
        selectedText: material,
        history: history.length ? history : undefined,
        responseFormat: action === "comment" ? undefined : "replacement",
      },
      action,
      scope,
      seen: new Set(),
    };
    setInstruction("");
    setActionOverride(null);
    if (placement === "inline") origin.editor.focus();
    await runTask(task, recipient);
  }

  async function runTask(task: Task, connection: WritingRecipient) {
    if (controller.current || rewriting || checkingDisk.current) return;
    const running = new AbortController();
    const { signal } = running;
    controller.current = running;
    taskRunning.current = true;
    const recipient = labelFor(connection);
    const entry = { task, recipientId: connection.id, recipient };
    const editing = task.action !== "comment";
    let text = "";
    let status: AttemptStatus;
    let finalReplacement: string | undefined;
    setRetryId("");
    setError(null);
    setAttempt({ ...entry, status: "working", partial: "" });

    try {
      const result = await connection.send(task.request, {
        signal,
        onDelta: (delta) => {
          if (signal.aborted) return;
          text += delta;
          setAttempt({ ...entry, status: "working", partial: text });
        },
      });
      text = result.text;
      status = signal.aborted ? "stopped" : replyStatus(result);
      if (editing && status === "complete") finalReplacement = replacementFromReply(result);
    } catch (problem) {
      status = failureStatus(problem, signal);
      if (mounted.current && status === "failed") reportSendError(problem);
    }
    if (!mounted.current) return;

    let appliedDirectly = false;
    if (finalReplacement !== undefined && task.action === "direct" && task.seen.size === 0) {
      try {
        appliedDirectly = await applyDirectly(finalReplacement, signal);
      } catch {
        // The proposal remains available for comparison if the disk cannot be refreshed.
      }
    }
    if (!mounted.current) return;
    if (signal.aborted && !appliedDirectly) status = "stopped";
    const progress = splitWritingProgress(text, editing);
    const replacement = status === "complete" ? finalReplacement : progress.replacement;
    const partial = status === "complete" ? "" : progress.partial;
    const edits = replacement === undefined ? undefined : selectionEdits(origin.text, replacement);
    const newEdits = edits?.filter((edit) => {
      const key = JSON.stringify([edit.from, edit.to, edit.before, edit.after]);
      if (task.seen.has(key)) return false;
      task.seen.add(key);
      return true;
    });
    const suggestions = newEdits && !appliedDirectly ? preview(newEdits) : undefined;
    setTurns((previous) => [
      ...previous,
      {
        instruction: task.request.instruction,
        reply: status === "complete" ? (replacement ?? text) : (replacement ?? ""),
        material: task.request.selectedText,
        recipient,
        recipientId: connection.id,
        appliedDirectly,
        suggestions,
        status,
        partial,
      },
    ]);
    setAttempt({ ...entry, status, partial: "" });
    controller.current = null;
    taskRunning.current = false;
  }

  const progress = splitWritingProgress(attempt?.partial ?? "", attempt?.task.action !== "comment");
  const inFlightCount = progress.replacement === undefined
    ? 0
    : selectionEdits(origin.text, progress.replacement).length;
  const stop = () => controller.current?.abort();
  const report = useMemo(() => attempt && ({
    tabId,
    name,
    recipient: attempt.recipient,
    material: t(`writing.scope.${attempt.task.scope}`),
    status: attempt.status,
    count: Math.max(inFlightCount, attempt.task.seen.size),
    stop: attempt.status === "working" ? () => controller.current?.abort() : undefined,
    reveal: () => {
      store.activate(tabId);
      setPlacement("sidebar");
    },
  }), [attempt, inFlightCount, name, setPlacement, store, t, tabId]);
  useWritingTask(report);

  const canRetry = attempt && attempt.status !== "working" && attempt.status !== "complete";
  const sameConnection = canRetry && recipients.find(({ id }) => id === attempt.recipientId);
  const otherConnection = canRetry && recipients.find(({ id }) => id === retryId);
  if (!placement) return null;
  const sidebar = placement === "sidebar";
  const Container = sidebar ? "aside" : "section";
  const messages = sidebar ? turns : turns.slice(-1);

  function renderReplyExcerpt(reply: string, collapsed = false) {
    const actions = <ReplyExcerpt reply={reply} origin={origin} originId={tabId} />;
    return (
      // Selecting and using a reply preserves the current pane as the cursor target.
      <fieldset className="min-w-0" onFocus={(event) => event.stopPropagation()}>
        {collapsed ? (
          <details className="space-y-2">
            <summary className="cursor-pointer">{t("writing.reply.useExcerpt")}</summary>
            {actions}
          </details>
        ) : (
          actions
        )}
      </fieldset>
    );
  }

  return (
    <Container
      aria-label={t(sidebar ? "writing.title" : "writing.ask")}
      className={`z-10 flex flex-col gap-3 overflow-auto border border-(--mint-border) bg-(--mint-bg) p-3 text-sm ${
        sidebar
          ? "min-h-0 min-w-0 border-r-0 border-b-0"
          : "absolute right-3 bottom-3 max-h-[70%] w-[min(36rem,calc(100%-1.5rem))] rounded-lg shadow-lg"
      }`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t(sidebar ? "writing.title" : "writing.ask")}</span>
        <button type="button" className={buttonClass} onClick={close}>
          {t("settings.close")}
        </button>
      </header>
      {sidebar && (
        <>
          <span className="wrap-anywhere">{name}</span>
          <button type="button" className={buttonClass} onClick={locate}>
            {t("writing.locate")}
          </button>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2">
            {origin.text}
          </pre>
        </>
      )}
      {messages.some((turn) => turn.suggestions?.length) && (
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showSource}
            onChange={(event) => setShowSource(event.target.checked)}
          />
          {t("writing.edit.source")}
        </label>
      )}
      <div aria-live="polite" className="space-y-2">
        {messages.map((turn, position) => {
          const index = sidebar ? position : turns.length - 1;
          const canRewrite = !loading && recipients.some(({ id }) => id === turn.recipientId);
          const { suggestions } = turn;
          return (
            <article key={index} className="space-y-1">
              {sidebar && (
                <details className="wrap-anywhere">
                  <summary>{turn.instruction}</summary>
                  <p>{turn.recipient}</p>
                  {turn.material !== undefined && (
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere">
                      {turn.material}
                    </pre>
                  )}
                </details>
              )}
              {suggestions?.length ? (
                suggestions.map((suggestion, position) => {
                  const { from, to } = suggestion.range.current();
                  const current = draft.slice(from, to);
                  const conflict = suggestion.status === "preview" && current !== suggestion.before;
                  const hasBoundaries = suggestion.range.hasBoundaries();
                  const blocked = externalChange || !hasBoundaries;
                  return (
                    <ProposedSelectionEdit
                      key={suggestion.id}
                      label={t("writing.edit.position", {
                        index: String(position + 1),
                        total: String(suggestions.length),
                      })}
                      before={suggestion.before}
                      after={suggestion.after}
                      status={suggestion.status}
                      source={showSource}
                      current={conflict ? current : undefined}
                      blocked={externalChange ? "disk" : !hasBoundaries ? "boundaries" : undefined}
                      busy={busy}
                      recipient={turn.recipient}
                      conversation={suggestion.comments?.map(({ id, instruction, reply }) => (
                        <div key={id} className="rounded bg-(--mint-hover) p-2">
                          <p className="font-medium">{instruction}</p>
                          {renderReplyExcerpt(reply)}
                        </div>
                      ))}
                      onApply={
                        blocked
                          ? undefined
                          : () => void decide(index, position, suggestion, current)
                      }
                      onDiscard={() => void decide(index, position, suggestion)}
                      onRewrite={
                        blocked || !canRewrite
                          ? undefined
                          : (prompt) => rewrite(index, position, turn, suggestion, current, prompt)
                      }
                    />
                  );
                })
              ) : suggestions ? (
                <p>{t("writing.edit.unchanged")}</p>
              ) : turn.appliedDirectly ? (
                <>
                  <p>{t("writing.edit.applied")}</p>
                  <pre className="whitespace-pre-wrap wrap-anywhere">{turn.reply}</pre>
                </>
              ) : null}
              {turn.partial && (
                <div>
                  <p>{t("writing.task.partial")}</p>
                  <pre className="whitespace-pre-wrap wrap-anywhere">{turn.partial}</pre>
                </div>
              )}
              {!!turn.reply &&
                renderReplyExcerpt(turn.reply, !!(suggestions || turn.appliedDirectly))}
            </article>
          );
        })}
        {attempt?.status === "working" && (
          <>
            <p>{t("writing.task.working")}</p>
            {progress.partial && <pre className="whitespace-pre-wrap wrap-anywhere">{progress.partial}</pre>}
          </>
        )}
        {rewriting && <p>{t("agent.working")}</p>}
        {canRetry && <p role="status">{t(`writing.task.${attempt.status}`)}</p>}
      </div>
      {attempt?.status === "working" && (
        <button type="button" className={buttonClass} onClick={stop}>
          {t("writing.task.stop")}
        </button>
      )}
      {canRetry && (
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={buttonClass} disabled={!sameConnection || busy}
            onClick={() => sameConnection && void runTask(attempt.task, sameConnection)}>
            {t("writing.task.retry")}
          </button>
          {recipients.some(({ id }) => id !== attempt.recipientId) && (
            <>
              <label className="grid gap-1">
                {t("writing.task.retryConnection")}
                <select className={fieldClass} value={retryId} onChange={(event) => setRetryId(event.target.value)}>
                  <option value="">{t("writing.chooseRecipient")}</option>
                  {recipients.filter(({ id }) => id !== attempt.recipientId).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{labelFor(candidate)}</option>
                  ))}
                </select>
              </label>
              <button type="button" className={buttonClass} disabled={!otherConnection || busy}
                onClick={() => otherConnection && void runTask(attempt.task, otherConnection)}>
                {t("writing.task.retryOther")}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">{t(error === "agentChanged" ? "agent.reviewAgain" : `writing.${error}`)}</p>
      )}
      {!sidebar && turns.length > 0 ? (
        <button
          type="button"
          className={`${buttonClass} self-start`}
          onClick={() => setPlacement("sidebar")}
        >
          {t("writing.continue")}
        </button>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-2">
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
            <label className="grid gap-1">
              {t("agent.instruction")}
              <input
                ref={input}
                className={fieldClass}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1">
                {t("writing.action")}
                <select
                  className={fieldClass}
                  value={action}
                  onChange={(event) => setActionOverride(event.target.value as Action)}
                >
                  {actions.map((id) => (
                    <option
                      key={id}
                      value={id}
                      disabled={scope !== "selection" && id !== "comment"}
                    >
                      {t(`writing.${id}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                {t("writing.scope")}
                <select
                  className={fieldClass}
                  value={scope}
                  onChange={(event) => setScope(event.target.value as Scope)}
                >
                  {scopes.map((id) => (
                    <option key={id} value={id}>
                      {t(`writing.scope.${id}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 flex-1 gap-1">
                {t("writing.recipient")}
                <select
                  className={fieldClass}
                  value={recipient?.id ?? ""}
                  title={recipient && labelFor(recipient)}
                  onChange={(event) => setRecipientId(event.target.value)}
                >
                  {!recipient && (
                    <option value="">
                      {t(loading ? "writing.loading" : "writing.chooseRecipient")}
                    </option>
                  )}
                  {recipients.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {labelFor(candidate)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {recipient?.kind === "agent" && (
              <p className="text-xs text-(--mint-muted)">
                {t("agent.processAccess")}{" "}
                {t(
                  recipient.access === "readOnly"
                    ? "agent.readOnlyAccess"
                    : "agent.configuredAccess",
                )}{" "}
                {t("agent.tools")} {t("agent.usesLogin")}
              </p>
            )}
            {loadFailed && <p role="alert">{t("writing.connectionsFailed")}</p>}
            {material !== undefined && (
              <div>
                <p className="text-xs text-(--mint-muted)">{t("writing.context")}</p>
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2">
                  {material}
                </pre>
              </div>
            )}
            {turns.length > 0 && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={includeHistory}
                  onChange={(event) => setIncludeHistory(event.target.checked)}
                />
                {t("writing.includeHistory")}
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className={buttonClass}
                disabled={!recipient || loading || !instruction.trim()}
              >
                {t("writing.send")}
              </button>
              <button type="button" className={buttonClass} onClick={onSettings}>
                {t("writing.manage")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </Container>
  );
}
