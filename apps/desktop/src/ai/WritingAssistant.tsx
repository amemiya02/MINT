import type { MintEditor } from "@mint/editor";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import { ReplyExcerpt } from "./ReplyExcerpt.tsx";
import { selectionEdits } from "./selection-edits.ts";
import { TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
import { WritingTasksDialog } from "./WritingTasksDialog.tsx";
import { loadWritingRecipients, type WritingRecipient } from "./writing-recipients.ts";
import {
  applyWritingSelection,
  captureWritingSelection,
  type WritingSelection,
} from "./writing-selection.ts";
import { replacementFromReply, type TaskContext } from "./writing-sender.ts";
import {
  mapReviewRanges,
  type ReviewRange,
  type SavedSuggestion,
  type SavedTurn,
  type SavedWritingTask,
} from "./writing-tasks.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

const scopes = ["selection", "document", "instruction"] as const;
type Scope = (typeof scopes)[number];
const actions = ["comment", "preview", "direct"] as const;
type Action = (typeof actions)[number];

interface Origin extends WritingSelection {
  readonly id: string;
}

interface Turn extends Omit<SavedTurn, "suggestions"> {
  readonly suggestions?: readonly Suggestion[];
}

type TrackedRange = ReturnType<Origin["range"]["trackSubrange"]>;
type Suggestion = Omit<SavedSuggestion, "range"> & {
  readonly range: TrackedRange;
};

interface RestoredReview {
  readonly task: SavedWritingTask;
  readonly mapper: ReturnType<typeof mapReviewRanges>;
}

function savedRange(range: TrackedRange): ReviewRange {
  return { ...range.current(), located: range.hasBoundaries() };
}

function restoreRange(editor: MintEditor, range: ReviewRange): Origin["range"] {
  const tracked = editor.trackRange(range);
  return { ...tracked, hasBoundaries: () => range.located && tracked.hasBoundaries() };
}

interface Props {
  readonly editor: MintEditor | null;
  readonly tabId: number;
  readonly path: string | null;
  readonly name: string;
  readonly active: boolean;
  readonly platform: Platform;
  readonly folder: string | null;
  readonly askRequest: number | null;
  readonly tasksRequest: number | null;
  readonly settingsOpen: boolean;
  readonly onAsk: () => void;
  readonly onTasks: () => void;
  readonly onSettings: () => void;
  readonly externalChange: boolean;
  readonly refreshDisk: () => Promise<boolean>;
  readonly children: ReactNode;
}

/** The editor owns its selection and scroll position, while the composer retains the task material. */
export function WritingAssistant({
  editor,
  tabId,
  path,
  name,
  active,
  platform,
  folder,
  askRequest,
  tasksRequest,
  settingsOpen,
  onAsk,
  onTasks,
  onSettings,
  externalChange,
  refreshDisk,
  children,
}: Props) {
  const t = useT();
  const [hasSelection, setHasSelection] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [restored, setRestored] = useState<RestoredReview | null>(null);
  const [placement, setPlacement] = useState<"inline" | "sidebar" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hasSavedTasks, setHasSavedTasks] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const lastAsk = useRef<number | null>(null);
  const lastHistory = useRef<number | null>(null);

  useEffect(() => {
    let current = true;
    void platform.writingTasks.list(path).then(
      (tasks) => {
        if (current) setHasSavedTasks(tasks.length > 0);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [platform, path]);

  useEffect(() => {
    if (tasksRequest === null || tasksRequest === lastHistory.current) return;
    lastHistory.current = tasksRequest;
    setHistoryOpen(true);
  }, [tasksRequest]);

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
    if (!askRequest || askRequest === lastAsk.current || !editor) return;
    lastAsk.current = askRequest;
    const selection = captureWritingSelection(editor);
    if (!selection) return;
    setOrigin({ id: crypto.randomUUID(), ...selection });
    setRestored(null);
    setPlacement("inline");
  }, [askRequest, editor]);

  useEffect(() => () => origin?.range.release(), [origin]);

  function openTask(task: SavedWritingTask) {
    if (!editor) return;
    if (task.id !== origin?.id) {
      const mapper = mapReviewRanges(task.baseline, editor.getText());
      setOrigin({
        id: task.id,
        editor,
        text: task.origin.text,
        range: restoreRange(editor, mapper.range(task.origin)),
      });
      setRestored({ task, mapper });
    }
    setPlacement("sidebar");
  }

  return (
    <div
      className={`relative grid min-h-0 min-w-0 flex-1 ${
        placement === "sidebar"
          ? "grid-rows-[minmax(0,1fr)_minmax(0,45%)] md:grid-cols-[minmax(0,1fr)_min(22rem,45%)] md:grid-rows-1"
          : "grid-rows-1"
      }`}
    >
      <div className="min-h-0 min-w-0">{children}</div>
      {!placement && active && (hasSelection || origin || hasSavedTasks) && (
        <div className="absolute right-4 bottom-4 z-10 flex gap-2">
          {hasSavedTasks && (
            <button type="button" className={buttonClass} onClick={onTasks}>
              {t("writing.tasks")}
            </button>
          )}
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
      {historyOpen && (
        <WritingTasksDialog
          tasks={platform.writingTasks}
          path={path}
          busyTask={busyTask}
          onClose={() => setHistoryOpen(false)}
          onOpen={openTask}
          onDelete={(id, remaining) => {
            setHasSavedTasks(remaining > 0);
            if (id !== origin?.id) return;
            setPlacement(null);
            setOrigin(null);
            setRestored(null);
          }}
        />
      )}
      {origin && origin.editor === editor && (
        <Composer
          key={origin.id}
          origin={origin}
          tabId={tabId}
          path={path}
          name={name}
          placement={placement}
          setPlacement={setPlacement}
          active={active}
          platform={platform}
          folder={folder}
          settingsOpen={settingsOpen}
          onSettings={onSettings}
          externalChange={externalChange}
          refreshDisk={refreshDisk}
          restored={restored}
          onSaved={() => setHasSavedTasks(true)}
          onTasks={onTasks}
          onBusyChange={setBusyTask}
        />
      )}
    </div>
  );
}

function Composer({
  origin,
  tabId,
  path,
  name,
  placement,
  setPlacement,
  active,
  platform,
  folder,
  settingsOpen,
  onSettings,
  externalChange,
  refreshDisk,
  restored,
  onSaved,
  onTasks,
  onBusyChange,
}: Pick<
  Props,
  | "tabId"
  | "path"
  | "name"
  | "active"
  | "platform"
  | "folder"
  | "settingsOpen"
  | "onSettings"
  | "onTasks"
  | "externalChange"
  | "refreshDisk"
> & {
  readonly origin: Origin;
  readonly restored: RestoredReview | null;
  readonly onSaved: () => void;
  readonly onBusyChange: (id: string | null) => void;
  readonly placement: "inline" | "sidebar" | null;
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
  const [title, setTitle] = useState(restored?.task.title ?? "");
  const [ready, setReady] = useState(!restored);
  const [saveFailed, setSaveFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"sendFailed" | "agentChanged" | "missingSelection" | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const review = useRef<HTMLElement>(null);
  const reviewScroll = useRef(restored?.task.reviewScroll ?? 0);
  const saves = useRef(Promise.resolve());
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(restored?.task.pending);
  const mounted = useRef(true);
  const isActive = useRef(active);
  isActive.current = active;
  const checkingDisk = useRef(false);
  const trackedSuggestions = useRef(new Set<TrackedRange>());
  const [showSource, setShowSource] = useState(restored?.task.showSource ?? false);
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

  const snapshot = useCallback(
    (taskTitle: string): SavedWritingTask => {
      const editor = origin.editor;
      return {
        version: 1,
        id: origin.id,
        path,
        title: taskTitle,
        updatedAt: Date.now(),
        baseline: editor.getText(),
        origin: { ...savedRange(origin.range), text: origin.text },
        reading: { ...editor.getSelection(), top: editor.getVisibleRange().from },
        reviewScroll: reviewScroll.current,
        showSource,
        pending: pending.current,
        turns: turns.map((turn) => ({
          ...turn,
          suggestions: turn.suggestions?.map((item) => ({
            ...item,
            range: savedRange(item.range),
          })),
        })),
      };
    },
    [origin, path, showSource, turns],
  );

  const persist = useCallback(
    (taskTitle = title) => {
      if (!taskTitle || !ready) return;
      const task = snapshot(taskTitle);
      saves.current = saves.current.then(async () => {
        try {
          await platform.writingTasks.update(task);
          if (mounted.current) setSaveFailed(false);
        } catch {
          if (mounted.current) setSaveFailed(true);
        }
      });
    },
    [platform, ready, snapshot, title],
  );

  const saveCheckpoint = useEffectEvent(persist);
  const saveReadingSoon = useEffectEvent(() => queueReadingSave());

  function queueReadingSave() {
    if (!title || !ready) return;
    if (readingTimer.current !== null) clearTimeout(readingTimer.current);
    readingTimer.current = setTimeout(() => {
      readingTimer.current = null;
      saveCheckpoint();
    }, 150);
  }

  useEffect(() => {
    mounted.current = true;
    const tracked = trackedSuggestions.current;
    if (restored) {
      const { task, mapper } = restored;
      setTurns(
        task.turns.map((turn) => ({
          ...turn,
          suggestions: turn.suggestions?.map((item) => {
            const range = restoreRange(origin.editor, mapper.range(item.range));
            tracked.add(range);
            return { ...item, range };
          }),
        })),
      );
      origin.editor.setSelection({
        anchor: mapper.point(task.reading.anchor),
        head: mapper.point(task.reading.head),
      });
      origin.editor.scrollTo(mapper.point(task.reading.top));
      if (review.current) review.current.scrollTop = reviewScroll.current;
      setReady(true);
    }
    return () => {
      mounted.current = false;
      if (readingTimer.current !== null) clearTimeout(readingTimer.current);
      for (const range of tracked) range.release();
      tracked.clear();
    };
  }, [origin, restored]);

  useEffect(() => {
    persist();
  }, [persist]);

  useEffect(() => {
    onBusyChange(busy ? origin.id : null);
    return () => onBusyChange(null);
  }, [busy, onBusyChange, origin.id]);

  useEffect(() => {
    if (!active || !placement) return;
    return origin.editor.subscribe(({ type }) => {
      if (type === "selection") saveCheckpoint();
      if (type === "scroll") saveReadingSoon();
    });
  }, [active, origin, placement]);

  useEffect(() => {
    if (ready && placement && review.current) review.current.scrollTop = reviewScroll.current;
  }, [ready, placement]);

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
    if (!placement || settingsOpen) return;
    if (restored) review.current?.focus({ preventScroll: true });
    else input.current?.focus();
  }, [placement, restored, settingsOpen]);

  function close() {
    persist();
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

  async function applyDirectly(replacement: string): Promise<boolean> {
    return (
      (await refreshDisk()) &&
      mounted.current &&
      applyWritingSelection(origin, replacement, true).status === "applied"
    );
  }

  function preview(replacement: string): Suggestion[] {
    return selectionEdits(origin.text, replacement).map((edit) => {
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
      const result = await connection.send(
        {
          instruction: prompt,
          selectedText: current,
          history: [{ instruction: turn.instruction, reply: suggestion.after }],
          responseFormat: "replacement",
        },
        { taskId: origin.id },
      );
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
    if (
      !instruction.trim() ||
      !recipient ||
      busy ||
      loading ||
      named.loading ||
      checkingDisk.current
    )
      return;
    if (restored && action !== "comment") {
      const { from, to } = origin.range.current();
      if (
        !origin.range.hasBoundaries() ||
        origin.editor.getText().slice(from, to) !== origin.text
      ) {
        setError("missingSelection");
        return;
      }
    }
    const prompt = instruction.trim();
    const history =
      includeHistory && turns.length
        ? turns.flatMap(({ instruction, reply, suggestions }) => [
            { instruction, reply },
            ...(suggestions?.flatMap(
              ({ comments }) =>
                comments?.map(({ instruction, reply }) => ({ instruction, reply })) ?? [],
            ) ?? []),
          ])
        : undefined;
    setBusy(true);
    setError(null);
    if (placement === "inline") origin.editor.focus();

    try {
      const draftSnapshot = sendDraft
        ? { name, text: origin.editor.getText().replace(/^\uFEFF/, "") }
        : undefined;
      const context: TaskContext | undefined =
        draftSnapshot || named.materials.length || searchFolder
          ? {
              currentDraft: draftSnapshot,
              materials: named.materials.length ? named.materials : undefined,
              folderSearch: searchFolder ? true : undefined,
            }
          : undefined;
      const submitted = {
        instruction: prompt,
        material: selectedText ?? draftSnapshot?.text,
        context,
        recipient: labelFor(recipient),
        recipientId: recipient.id,
      };
      pending.current = submitted;
      if (title) persist();
      else {
        try {
          await platform.writingTasks.create(snapshot(prompt));
        } catch {
          if (mounted.current) setSaveFailed(true);
          return;
        }
        if (!mounted.current) return;
        setTitle(prompt);
        setSaveFailed(false);
        onSaved();
      }
      let sentContext = context;
      const result = await materialRequests.send(
        (outbound) => {
          sentContext = outbound.taskContext;
          pending.current = { ...submitted, context: sentContext };
          persist(title || prompt);
          return recipient.send(outbound, { taskId: origin.id });
        },
        {
          instruction: prompt,
          selectedText,
          history,
          responseFormat: action === "comment" ? undefined : "replacement",
          taskContext: context,
        },
        labelFor(recipient),
        searchFolder,
      );
      if (!mounted.current) return;
      const replacement = action === "comment" ? undefined : replacementFromReply(result);
      const appliedDirectly =
        replacement !== undefined && action === "direct" && (await applyDirectly(replacement));
      if (!mounted.current) return;
      const suggestions =
        replacement !== undefined && !appliedDirectly ? preview(replacement) : undefined;
      pending.current = undefined;
      setTurns((previous) => [
        ...previous,
        {
          ...submitted,
          context: sentContext,
          reply: replacement ?? result.text,
          appliedDirectly,
          suggestions,
        },
      ]);
      setInstruction("");
      setActionOverride(null);
      setAllowedFolder(null);
    } catch (problem) {
      if (mounted.current) reportSendError(problem);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

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

  function renderSentContext(context: TaskContext | undefined) {
    if (!context) return null;
    const materials = [
      ...(context.currentDraft ? [context.currentDraft] : []),
      ...(context.materials ?? []),
      ...(context.materialDecisions ?? []).flatMap((decision) =>
        decision.outcome === "allowed" ? [decision.material] : [],
      ),
    ];
    return (
      <fieldset className="space-y-1 rounded border border-(--mint-border) p-2 text-xs">
        <legend className="px-1">{t("writing.tasks.sentContext")}</legend>
        {context.folderSearch && <p>{t("materials.allowSearch")}</p>}
        {materials.map(({ name, text }, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A turn keeps its original material order, including duplicates.
          <details key={`${index}:${name}`} className="wrap-anywhere">
            <summary>{name}</summary>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap">{text}</pre>
          </details>
        ))}
        {context.materialDecisions?.map((decision) =>
          decision.outcome === "skipped" ? (
            <p key={decision.name}>{t("writing.tasks.skippedMaterial", { name: decision.name })}</p>
          ) : null,
        )}
      </fieldset>
    );
  }

  return (
    <Container
      ref={review}
      tabIndex={-1}
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
      onScroll={(event) => {
        if (event.target !== event.currentTarget) return;
        reviewScroll.current = event.currentTarget.scrollTop;
        queueReadingSave();
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t(sidebar ? "writing.title" : "writing.ask")}</span>
        <div className="flex gap-2">
          {title && (
            <button type="button" className={buttonClass} disabled={busy} onClick={onTasks}>
              {t("writing.tasks")}
            </button>
          )}
          <button type="button" className={buttonClass} onClick={close}>
            {t("settings.close")}
          </button>
        </div>
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
              {sidebar && renderSentContext(turn.context)}
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
              {!!turn.reply &&
                renderReplyExcerpt(turn.reply, !!(suggestions || turn.appliedDirectly))}
            </article>
          );
        })}
        {sidebar && restored && !turns.length && pending.current && !busy && (
          <article className="space-y-1">
            <p>{pending.current.instruction}</p>
            <p>{pending.current.recipient}</p>
            {renderSentContext(pending.current.context)}
          </article>
        )}
        {busy && !materialRequests.pending && <p>{t("agent.working")}</p>}
      </div>
      {error && (
        <p role="alert">{t(error === "agentChanged" ? "agent.reviewAgain" : `writing.${error}`)}</p>
      )}
      {saveFailed && <p role="alert">{t("writing.tasks.saveFailed")}</p>}
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
                {t("writing.send")}
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
          onDecision={materialRequests.decide}
        />
      )}
    </Container>
  );
}
