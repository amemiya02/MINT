import type { MintEditor, TextRange } from "@mint/editor";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useTabStore } from "../tabs/context.ts";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { type EditStatus, ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import { ReplyExcerpt } from "./ReplyExcerpt.tsx";
import { type SelectionEdit, selectionEdits } from "./selection-edits.ts";
import { TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
import { useWritingTask, WritingTaskMaterials } from "./WritingTasks.tsx";
import {
  type AttemptStatus,
  failureStatus,
  replyStatus,
  writingMaterialNames,
} from "./writing-attempt.ts";
import { loadWritingRecipients, type WritingRecipient } from "./writing-recipients.ts";
import { captureWritingSelection, type WritingSelection } from "./writing-selection.ts";
import {
  type NamedMaterial,
  replacementFromReply,
  splitWritingProgress,
  type WritingRequest,
  type WritingTurn,
} from "./writing-sender.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

const scopes = ["selection", "document", "instruction"] as const;
type Scope = (typeof scopes)[number];
const actions = ["comment", "preview", "direct"] as const;

function editKey({ from, to, before, after }: SelectionEdit) {
  return JSON.stringify([from, to, before, after]);
}
type Action = (typeof actions)[number];

interface Origin extends WritingSelection {
  readonly id: number;
}

interface Task {
  readonly request: WritingRequest;
  readonly action: Action;
  readonly scope: Scope;
  readonly searchFolder: string | null;
  readonly seen: Set<string>;
  readonly rewrite?: { index: number; position: number; current: string };
}

interface Attempt {
  readonly task: Task;
  readonly recipientId: string;
  readonly recipient: string;
  readonly status: AttemptStatus;
  readonly partial: string;
  readonly approved: readonly NamedMaterial[];
}

interface Turn extends WritingTurn {
  readonly status?: AttemptStatus;
  readonly partial?: string;
  readonly material?: string;
  readonly recipient: string;
  readonly recipientId: string;
  readonly direct: boolean;
  readonly suggestions?: readonly Suggestion[];
}

type TrackedRange = ReturnType<Origin["range"]["trackSubrange"]>;
type Suggestion = Pick<SelectionEdit, "before" | "after"> & {
  readonly id: number;
  readonly range: TrackedRange;
  readonly status: EditStatus;
  readonly appliedText?: string;
  readonly comments?: readonly (WritingTurn & { readonly id: number })[];
};

function currentText({ range }: Suggestion, draft: string) {
  const { from, to } = range.current();
  return draft.slice(from, to);
}

function isApplied(suggestion: Suggestion, draft: string) {
  return (
    suggestion.status === "applied" &&
    suggestion.appliedText !== undefined &&
    currentText(suggestion, draft) !== suggestion.before
  );
}

interface Props {
  readonly editor: MintEditor | null;
  readonly tabId: number;
  readonly name: string;
  readonly active: boolean;
  readonly platform: Platform;
  readonly folder: string | null;
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
  folder,
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
          folder={folder}
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
  folder,
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
  | "folder"
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
  const [includeDraft, setIncludeDraft] = useState(false);
  const [allowedFolder, setAllowedFolder] = useState<string | null>(null);
  const searchFolder = allowedFolder === folder ? folder : null;
  const named = useNamedMaterials();
  const materialRequests = useMaterialRequests();
  const [includeHistory, setIncludeHistory] = useState(true);
  const [recipients, setRecipients] = useState<readonly WritingRecipient[]>([]);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [retryId, setRetryId] = useState("");
  const controller = useRef<AbortController | null>(null);
  const busy = attempt?.status === "working" || attempt?.status === "approval";
  const store = useTabStore();
  const [error, setError] = useState<"sendFailed" | "agentChanged" | "missingSelection" | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const openingChanges = useRef(false);
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
  const selectedText = scope === "selection" ? origin.text : undefined;
  const sendDraft = scope === "document" || (scope === "selection" && includeDraft);
  const currentDraft = sendDraft ? { name, text: draft.replace(/^\uFEFF/, "") } : undefined;
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
    if (!placement || !isActive.current || settingsOpen) return;
    if (openingChanges.current) {
      heading.current?.focus();
      openingChanges.current = false;
    } else {
      input.current?.focus();
    }
  }, [placement, settingsOpen]);

  function viewChanges() {
    openingChanges.current = placement !== "sidebar";
    setPlacement("sidebar");
  }

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

  function releaseRange(range: TrackedRange) {
    if (trackedSuggestions.current.delete(range)) range.release();
  }

  function recordApplied(
    suggestion: Suggestion,
    range: TextRange,
    appliedText: string,
    before = suggestion.before,
  ): Suggestion {
    releaseRange(suggestion.range);
    const tracked = origin.editor.trackRange(range);
    trackedSuggestions.current.add(tracked);
    return { ...suggestion, range: tracked, appliedText, before, status: "applied" };
  }

  async function applyDirectly(
    suggestions: Suggestion[],
    signal: AbortSignal,
  ): Promise<Suggestion[]> {
    if (!(await refreshDisk()) || !mounted.current || signal.aborted) return suggestions;
    const draft = origin.editor.getText();
    const applicable = suggestions.flatMap((suggestion) => {
      if (!suggestion.range.hasBoundaries()) return [];
      const range = suggestion.range.current();
      return draft.slice(range.from, range.to) === suggestion.before
        ? [{ ...range, text: suggestion.after, id: suggestion.id }]
        : [];
    });
    const target = origin.range.current();
    const { anchor, head } = origin.editor.getSelection();
    const stillAtTarget =
      isActive.current &&
      Math.min(anchor, head) === target.from &&
      Math.max(anchor, head) === target.to;
    const inserted = origin.editor.replaceRanges(applicable, {
      collapseSelection: stillAtTarget ? target : undefined,
      lineEndings: "match",
    });
    const applied = new Map(applicable.map(({ id }, index) => [id, inserted[index]]));
    const edited = origin.editor.getText();
    return suggestions.map((suggestion) => {
      const range = applied.get(suggestion.id);
      return range
        ? recordApplied(suggestion, range, edited.slice(range.from, range.to))
        : suggestion;
    });
  }

  async function revertDirect(
    index: number,
    suggestions: readonly Suggestion[],
    compared?: string,
  ) {
    if (busy || checkingDisk.current) return;
    checkingDisk.current = true;
    try {
      if (!(await refreshDisk()) || !mounted.current) {
        if (mounted.current) viewChanges();
        return;
      }
      const live = origin.editor.getText();
      let needsComparison = false;
      const replacements = suggestions.flatMap(({ id, status, appliedText, range, before }) => {
        if (status !== "applied" || appliedText === undefined) return [];
        const { from, to } = range.current();
        const current = live.slice(from, to);
        if (current === before) return [];
        if (!range.hasBoundaries() || current !== (compared ?? appliedText)) {
          needsComparison = true;
          return [];
        }
        return [{ id, from, to, text: before }];
      });
      origin.editor.replaceRanges(replacements, { lineEndings: "preserve" });
      const reverted = new Set(replacements.map(({ id }) => id));
      for (const { id, range } of suggestions) if (reverted.has(id)) releaseRange(range);
      setTurns((previous) =>
        previous.map((turn, i) =>
          i === index
            ? {
                ...turn,
                suggestions: turn.suggestions?.map((suggestion) =>
                  reverted.has(suggestion.id) ? { ...suggestion, status: "reverted" } : suggestion,
                ),
              }
            : turn,
        ),
      );
      if (needsComparison) viewChanges();
      else if (isActive.current && placement === "inline") origin.editor.focus();
    } finally {
      checkingDisk.current = false;
    }
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
    let update: Partial<Suggestion> = { status: "discarded" };
    if (acceptedText !== undefined) {
      checkingDisk.current = true;
      try {
        if (!(await refreshDisk()) || !mounted.current || !suggestion.range.hasBoundaries()) return;
        const range = suggestion.range.current();
        if (origin.editor.getText().slice(range.from, range.to) !== acceptedText) return;
        update = { status: "applied" };
        if (acceptedText !== suggestion.after) {
          const [inserted] = origin.editor.replaceRanges([{ ...range, text: suggestion.after }], {
            collapseSelection: range,
            lineEndings: "match",
          });
          if (turns[index]?.direct && inserted) {
            const edited = origin.editor.getText();
            update = recordApplied(
              suggestion,
              inserted,
              edited.slice(inserted.from, inserted.to),
              acceptedText,
            );
          }
        }
        if (isActive.current) origin.editor.focus();
      } finally {
        checkingDisk.current = false;
      }
    }
    releaseRange(suggestion.range);
    updateSuggestion(index, position, update);
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
    return runTask(
      {
        request: {
          instruction: prompt,
          selectedText: current,
          history: [{ instruction: turn.instruction, reply: suggestion.after }],
          responseFormat: "replacement",
        },
        action: "preview",
        scope: "selection",
        searchFolder: null,
        seen: new Set(),
        rewrite: { index, position, current },
      },
      connection,
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !instruction.trim() ||
      !recipient ||
      busy ||
      loading ||
      named.loading ||
      checkingDisk.current
    )
      return;
    const history = includeHistory
      ? turns.flatMap(({ status, instruction, reply, suggestions }) => [
          ...(status === "complete" && reply ? [{ instruction, reply }] : []),
          ...(suggestions?.flatMap(
            ({ comments }) =>
              comments?.map(({ instruction, reply }) => ({ instruction, reply })) ?? [],
          ) ?? []),
        ])
      : [];
    const draftSnapshot = sendDraft
      ? { name, text: origin.editor.getText().replace(/^\uFEFF/, "") }
      : undefined;
    const task: Task = {
      request: {
        instruction: instruction.trim(),
        selectedText,
        taskContext:
          draftSnapshot || named.materials.length || searchFolder
            ? {
                currentDraft: draftSnapshot,
                materials: named.materials.length ? named.materials : undefined,
                folderSearch: searchFolder ? true : undefined,
              }
            : undefined,
        history: history.length ? history : undefined,
        responseFormat: action === "comment" ? undefined : "replacement",
      },
      action,
      scope,
      searchFolder,
      seen: new Set(),
    };
    setInstruction("");
    setActionOverride(null);
    setAllowedFolder(null);
    if (placement === "inline") origin.editor.focus();
    await runTask(task, recipient);
  }

  async function runTask(task: Task, connection: WritingRecipient) {
    if (controller.current || checkingDisk.current) return false;
    const running = new AbortController();
    const { signal } = running;
    controller.current = running;
    taskRunning.current = true;
    const recipient = labelFor(connection);
    const entry = { task, recipientId: connection.id, recipient };
    const editing = task.action !== "comment";
    let text = "";
    let approved: NamedMaterial[] = [];
    let status: AttemptStatus;
    let finalReplacement: string | undefined;
    setRetryId("");
    setError(null);
    setAttempt({ ...entry, approved, status: "working", partial: "" });

    try {
      const result = await materialRequests.send(
        connection.send,
        task.request,
        recipient,
        task.searchFolder,
        {
          signal,
          onApproval: () => {
            text = "";
            setAttempt({ ...entry, approved, status: "approval", partial: "" });
          },
          onResume: (decision) => {
            text = "";
            if (decision?.outcome === "allowed") approved = [...approved, decision.material];
            if (!signal.aborted) setAttempt({ ...entry, approved, status: "working", partial: "" });
          },
          onDelta: (delta) => {
            if (signal.aborted) return;
            text += delta;
            setAttempt({ ...entry, approved, status: "working", partial: text });
          },
        },
      );
      text = result.text;
      status = signal.aborted ? "stopped" : replyStatus(result);
      if (editing && status === "complete") finalReplacement = replacementFromReply(result);
    } catch (problem) {
      status = failureStatus(problem, signal);
      if (mounted.current && status === "failed") reportSendError(problem);
    }
    if (!mounted.current) return false;

    const canApplyDirectly =
      status === "complete" && task.action === "direct" && task.seen.size === 0;
    if (signal.aborted) status = "stopped";
    const progress = splitWritingProgress(text, editing);
    const replacement = status === "complete" ? finalReplacement : progress.replacement;
    const partial = status === "complete" ? "" : progress.partial;
    const edits =
      replacement === undefined
        ? undefined
        : selectionEdits(task.rewrite?.current ?? origin.text, replacement);
    const newEdits = edits?.filter((edit) => {
      const key = editKey(edit);
      if (task.seen.has(key)) return false;
      task.seen.add(key);
      return true;
    });
    const rewrite = task.rewrite;
    if (rewrite) {
      setTurns((previous) =>
        previous.map((turn, index) =>
          index === rewrite.index
            ? {
                ...turn,
                suggestions: turn.suggestions?.map((suggestion, position) => {
                  if (position !== rewrite.position || suggestion.status !== "preview")
                    return suggestion;
                  if (replacement !== undefined && newEdits?.length) {
                    return { ...suggestion, before: rewrite.current, after: replacement };
                  }
                  if (status !== "complete" || replacement !== undefined) return suggestion;
                  const comments = suggestion.comments ?? [];
                  return {
                    ...suggestion,
                    comments: [
                      ...comments,
                      { id: comments.length, instruction: task.request.instruction, reply: text },
                    ],
                  };
                }),
              }
            : turn,
        ),
      );
    }
    let suggestions = !rewrite && newEdits ? preview(newEdits) : undefined;
    if (canApplyDirectly && suggestions?.length) {
      try {
        suggestions = await applyDirectly(suggestions, signal);
      } catch {
        // The proposal remains available for comparison if the disk cannot be refreshed.
      }
    }
    if (!mounted.current) return false;
    if (signal.aborted) status = "stopped";
    if (!rewrite || partial)
      setTurns((previous) => [
        ...previous,
        {
          instruction: task.request.instruction,
          reply: rewrite ? "" : status === "complete" ? (replacement ?? text) : (replacement ?? ""),
          material: task.request.selectedText ?? task.request.taskContext?.currentDraft?.text,
          recipient,
          recipientId: connection.id,
          direct: task.action === "direct",
          suggestions,
          status,
          partial,
        },
      ]);
    setAttempt({ ...entry, approved, status, partial: "" });
    controller.current = null;
    taskRunning.current = false;
    return status === "complete";
  }

  const progress = splitWritingProgress(attempt?.partial ?? "", attempt?.task.action !== "comment");
  const task = attempt?.task;
  const replacement = progress.replacement;
  const currentEdits = useMemo(
    () =>
      replacement === undefined
        ? []
        : selectionEdits(task?.rewrite?.current ?? origin.text, replacement),
    [task, replacement, origin.text],
  );
  const distinct = task ? new Set([...task.seen, ...currentEdits.map(editKey)]).size : 0;
  const count = task?.rewrite ? Number(distinct > 0) : distinct;
  const stop = () => controller.current?.abort();
  const status = attempt?.status;
  const sendingTo = attempt?.recipient;
  const materials = task
    ? [
        t(`writing.scope.${task.scope}`),
        ...writingMaterialNames(task.request),
        ...(attempt?.approved.map(({ name }) => name) ?? []),
        ...(materialRequests.pending ? [materialRequests.pending.name] : []),
      ].join(" · ")
    : "";
  const report = useMemo(
    () =>
      status && sendingTo
        ? {
            tabId,
            name,
            recipient: sendingTo,
            material: materials,
            status,
            count,
            stop:
              status === "working" || status === "approval"
                ? () => controller.current?.abort()
                : undefined,
            reveal: () => {
              store.activate(tabId);
              setPlacement("sidebar");
            },
          }
        : null,
    [count, materials, name, sendingTo, setPlacement, status, store, tabId],
  );
  useWritingTask(report);

  const canRetry = attempt && !busy && attempt.status !== "complete";
  const sameConnection = canRetry && recipients.find(({ id }) => id === attempt.recipientId);
  const otherConnection = canRetry && recipients.find(({ id }) => id === retryId);
  if (!placement) return null;
  const sidebar = placement === "sidebar";
  const latest = turns.at(-1);
  if (
    !sidebar &&
    !busy &&
    latest?.status === "complete" &&
    latest.direct &&
    latest.suggestions?.length
  ) {
    const { suggestions } = latest;
    const applied = suggestions.filter((suggestion) => isApplied(suggestion, draft)).length;
    const pending = suggestions.filter(({ status }) => status === "preview").length;
    const summary =
      pending === 0 && applied === 0
        ? t("writing.edit.noneApplied")
        : applied === 1 && pending === 0
          ? t("writing.edit.applied")
          : t("writing.edit.summary", { applied: String(applied), pending: String(pending) });
    return (
      <section
        aria-label={t("writing.ask")}
        className="absolute right-3 bottom-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-lg border border-(--mint-border) bg-(--mint-bg) p-2 text-sm shadow-lg"
      >
        <span role="status">{summary}</span>
        <button type="button" className={buttonClass} onClick={viewChanges}>
          {t("writing.viewChanges")}
        </button>
        {applied > 0 && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => void revertDirect(turns.length - 1, suggestions)}
          >
            {t("writing.edit.undoDirect")}
          </button>
        )}
        <button type="button" className={buttonClass} onClick={close}>
          {t("settings.close")}
        </button>
      </section>
    );
  }
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
        <span ref={heading} tabIndex={-1} className="font-medium">
          {t(sidebar ? "writing.title" : "writing.ask")}
        </span>
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
      {sidebar && attempt && (
        <WritingTaskMaterials
          request={attempt.task.request}
          approved={attempt.approved}
          folder={attempt.task.searchFolder}
        />
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
              {sidebar &&
                turn.direct &&
                suggestions?.some((suggestion) => isApplied(suggestion, draft)) && (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => void revertDirect(index, suggestions)}
                  >
                    {t("writing.edit.undoDirect")}
                  </button>
                )}
              {suggestions?.length ? (
                suggestions.map((suggestion, position) => {
                  const current = currentText(suggestion, draft);
                  const pending = suggestion.status === "preview";
                  const conflict = pending && current !== suggestion.before;
                  const canRevert =
                    suggestion.status === "applied" && suggestion.appliedText !== undefined;
                  const reverted = canRevert && current === suggestion.before;
                  const revertConflict =
                    canRevert && !reverted && current !== suggestion.appliedText;
                  const blocked = externalChange
                    ? "disk"
                    : !suggestion.range.hasBoundaries()
                      ? "boundaries"
                      : undefined;
                  return (
                    <ProposedSelectionEdit
                      key={suggestion.id}
                      label={t("writing.edit.position", {
                        index: String(position + 1),
                        total: String(suggestions.length),
                      })}
                      before={suggestion.before}
                      after={suggestion.appliedText ?? suggestion.after}
                      status={reverted ? "reverted" : suggestion.status}
                      showAppliedComparison={turn.direct}
                      source={showSource}
                      current={conflict || revertConflict ? current : undefined}
                      blocked={pending || (canRevert && !reverted) ? blocked : undefined}
                      busy={busy}
                      recipient={turn.recipient}
                      conversation={suggestion.comments?.map(({ id, instruction, reply }) => (
                        <div key={id} className="rounded bg-(--mint-hover) p-2">
                          <p className="font-medium">{instruction}</p>
                          {renderReplyExcerpt(reply)}
                        </div>
                      ))}
                      onApply={
                        blocked || !pending
                          ? undefined
                          : () => void decide(index, position, suggestion, current)
                      }
                      onDiscard={
                        pending ? () => void decide(index, position, suggestion) : undefined
                      }
                      onRevert={
                        canRevert && !reverted && !blocked
                          ? () => void revertDirect(index, [suggestion], current)
                          : undefined
                      }
                      onRewrite={
                        blocked || !pending || !canRewrite
                          ? undefined
                          : (prompt) => rewrite(index, position, turn, suggestion, current, prompt)
                      }
                    />
                  );
                })
              ) : suggestions ? (
                <p>{t("writing.edit.unchanged")}</p>
              ) : null}
              {turn.partial && (
                <div>
                  <p>{t("writing.task.partial")}</p>
                  <pre className="whitespace-pre-wrap wrap-anywhere">{turn.partial}</pre>
                </div>
              )}
              {!!turn.reply && renderReplyExcerpt(turn.reply, suggestions !== undefined)}
            </article>
          );
        })}
        {attempt?.status === "working" && (
          <>
            <p>{t("writing.task.working")}</p>
            {progress.partial && (
              <pre className="whitespace-pre-wrap wrap-anywhere">{progress.partial}</pre>
            )}
          </>
        )}
        {canRetry && <p role="status">{t(`writing.task.${attempt.status}`)}</p>}
      </div>
      {(attempt?.status === "working" || attempt?.status === "approval") && (
        <button type="button" className={buttonClass} onClick={stop}>
          {t("writing.task.stop")}
        </button>
      )}
      {canRetry && (
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={!sameConnection || busy}
            onClick={() => sameConnection && void runTask(attempt.task, sameConnection)}
          >
            {t("writing.task.retry")}
          </button>
          <p className="basis-full text-xs text-(--mint-muted)">
            {[
              t(`writing.scope.${attempt.task.scope}`),
              ...writingMaterialNames(attempt.task.request),
              attempt.task.searchFolder,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {recipients.some(({ id }) => id !== attempt.recipientId) && (
            <>
              <label className="grid gap-1">
                {t("writing.task.retryConnection")}
                <select
                  className={fieldClass}
                  value={retryId}
                  onChange={(event) => setRetryId(event.target.value)}
                >
                  <option value="">{t("writing.chooseRecipient")}</option>
                  {recipients
                    .filter(({ id }) => id !== attempt.recipientId)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {labelFor(candidate)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className={buttonClass}
                disabled={!otherConnection || busy}
                onClick={() => otherConnection && void runTask(attempt.task, otherConnection)}
              >
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
          <fieldset
            disabled={busy}
            className={materialRequests.pending ? "hidden" : "flex min-w-0 flex-col gap-2"}
          >
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
                  onChange={(event) => {
                    setRecipientId(event.target.value);
                    setAllowedFolder(null);
                    setIncludeHistory(false);
                  }}
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
            <TaskContextChecklist
              platform={platform}
              named={named}
              recipient={recipient && labelFor(recipient)}
              selection={selectedText}
              draft={currentDraft}
              includeDraft={scope === "selection" ? setIncludeDraft : undefined}
              folder={folder}
              searchEnabled={!!searchFolder}
              onSearchChange={(checked) => setAllowedFolder(checked ? folder : null)}
            />
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
                disabled={!recipient || loading || !instruction.trim() || named.loading}
              >
                {recipient
                  ? t("writing.sendAuthorized", {
                      action: t(`writing.${action}`),
                      scope: t(`writing.scope.${scope}`),
                      recipient: labelFor(recipient),
                    })
                  : t("writing.send")}
              </button>
              <button type="button" className={buttonClass} onClick={onSettings}>
                {t("writing.manage")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {materialRequests.pending && (
        <MaterialRequestNotice
          key={materialRequests.pending.id}
          pending={materialRequests.pending}
          platform={platform}
          onDecision={(decision) => {
            materialRequests.decide(decision);
            if (active && attempt?.task.action === "direct") origin.editor.focus();
          }}
        />
      )}
    </Container>
  );
}
