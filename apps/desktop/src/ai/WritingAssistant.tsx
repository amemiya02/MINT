import type { MintEditor, TextRange } from "@mint/editor";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n/index.ts";
import { isWithin, parentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useTabStore } from "../tabs/context.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { FocusedWritingReview, type ReviewEntry } from "./FocusedWritingReview.tsx";
import { materialLabel } from "./material-display.ts";
import {
  type MaterialPlan,
  MaterialPlanPreview,
  useMaterialCapacity,
} from "./MaterialCapacity.tsx";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { useModelVision, VisionControl } from "./ModelVision.tsx";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import { ReplyExcerpt } from "./ReplyExcerpt.tsx";
import { type SelectionEdit, selectionEdits } from "./selection-edits.ts";
import { MaterialPreview, TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
import { useWritingTask, WritingTaskMaterials } from "./WritingTasks.tsx";
import {
  type AttemptStatus,
  failureStatus,
  isMaterialCapacityError,
  replyStatus,
  writingMaterialNames,
} from "./writing-attempt.ts";
import { loadWritingRecipients, type WritingRecipient } from "./writing-recipients.ts";
import { captureWritingSelection, type WritingSelection } from "./writing-selection.ts";
import {
  contextMaterials,
  hasTaskImages,
  type NamedMaterial,
  replacementFromReply,
  splitWritingProgress,
  type TaskContext,
  type WritingRequest,
} from "./writing-sender.ts";
import {
  mapReviewRanges,
  openWritingReviews,
  type ReviewRange,
  registerTaskCheckpoint,
  type SavedReviewLink,
  type SavedSuggestion,
  type SavedTurn,
  type SavedWritingTask,
  type WritingTaskOpenRequest,
  type WritingTaskOpenResult,
  writeTaskCheckpoint,
  writingTaskWrites,
} from "./writing-tasks.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

const scopes = ["selection", "document", "instruction"] as const;
type Scope = (typeof scopes)[number] | "folder";
const actions = ["comment", "preview", "direct"] as const;
type Action = (typeof actions)[number];

function editKey({ from, to, before, after }: SelectionEdit) {
  return JSON.stringify([from, to, before, after]);
}

interface Origin extends WritingSelection {
  readonly id: string;
  readonly folder?: string;
}

interface Task {
  readonly request: WritingRequest;
  readonly plan?: MaterialPlan;
  readonly action: Action;
  readonly scope: Scope;
  readonly searchFolder: string | null;
  readonly seen: Set<string>;
  readonly rewrite?: { index: number; position: number; current: string };
}

interface Attempt {
  readonly id: string;
  readonly task: Task;
  readonly recipientId: string;
  readonly recipient: string;
  readonly status: AttemptStatus;
  readonly partial: string;
  readonly approved: readonly NamedMaterial[];
  readonly newDecisions?: number;
  readonly capacityRejected?: boolean;
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
  readonly restoreReading: boolean;
}

function savedRange(range: TrackedRange): ReviewRange {
  return { ...range.current(), located: range.hasBoundaries() };
}

function restoreRange(editor: MintEditor, range: ReviewRange): Origin["range"] {
  const tracked = editor.trackRange(range);
  return { ...tracked, hasBoundaries: () => range.located && tracked.hasBoundaries() };
}

function currentText({ range }: Suggestion, draft: string) {
  const { from, to } = range.current();
  return draft.slice(from, to);
}

function reviewStatus(suggestion: Suggestion, draft: string) {
  return suggestion.batchApplied &&
    suggestion.status === "applied" &&
    currentText(suggestion, draft) === suggestion.before
    ? "preview"
    : suggestion.status;
}

function canRevert(suggestion: Suggestion) {
  return suggestion.status === "applied" && suggestion.appliedText !== undefined;
}

function isApplied(suggestion: Suggestion, draft: string) {
  return (
    canRevert(suggestion) &&
    (!suggestion.range.hasBoundaries() || currentText(suggestion, draft) !== suggestion.before)
  );
}

interface Props {
  readonly editor: MintEditor | null;
  readonly tabId: number;
  readonly path: string | null;
  readonly name: string;
  readonly active: boolean;
  readonly platform: Platform;
  readonly folder: string | null;
  readonly askRequest: { readonly folder?: string } | null;
  readonly taskRestore: WritingTaskOpenRequest | null;
  readonly taskListRevision: number;
  readonly settingsOpen: boolean;
  readonly onAsk: () => void;
  readonly onTasks: () => void;
  readonly onOpenReview: (
    task: SavedWritingTask,
    returnToTab: number,
  ) => Promise<WritingTaskOpenResult>;
  readonly onActivate: () => void;
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
  taskRestore,
  taskListRevision,
  settingsOpen,
  onAsk,
  onTasks,
  onOpenReview,
  onActivate,
  onSettings,
  externalChange,
  refreshDisk,
  children,
}: Props) {
  const t = useT();
  const [hasSelection, setHasSelection] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [temporary, setTemporary] = useState(false);
  const [restored, setRestored] = useState<RestoredReview | null>(null);
  const taskRunning = useRef(false);
  const [placement, setPlacement] = useState<"inline" | "sidebar" | null>(null);
  const [reviewStart, setReviewStart] = useState<{ id: string; returnToTab: number } | null>(null);
  const [hasSavedTasks, setHasSavedTasks] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const lastAsk = useRef<typeof askRequest>(null);
  const lastRestore = useRef<typeof taskRestore>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changes to task records invalidate this document's saved task list.
  useEffect(() => {
    let current = true;
    void writingTaskWrites(platform.writingTasks)
      .then(() => platform.writingTasks.list(path))
      .then(
        (tasks) => {
          if (current) setHasSavedTasks(tasks.length > 0);
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [platform, path, taskListRevision]);

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
    if (taskRunning.current || temporary) {
      setPlacement("sidebar");
      return;
    }
    const selection = captureWritingSelection(editor, !!askRequest.folder);
    if (!selection) return;
    setOrigin({ id: crypto.randomUUID(), ...selection, folder: askRequest.folder });
    setRestored(null);
    setPlacement(askRequest.folder ? "sidebar" : "inline");
  }, [askRequest, editor, temporary]);

  useEffect(() => () => origin?.range.release(), [origin]);

  useEffect(() => {
    if (!origin || origin.editor !== editor) return;
    const reviews = openWritingReviews(platform.writingTasks);
    reviews.set(origin.id, {
      tabId,
      busy: busyTask === origin.id,
      temporary,
      focus(returnToTab) {
        onActivate();
        setPlacement("sidebar");
        if (returnToTab !== undefined) setReviewStart({ id: origin.id, returnToTab });
      },
      remove() {
        setPlacement(null);
        setOrigin(null);
        setRestored(null);
      },
    });
    return () => {
      reviews.delete(origin.id);
    };
  }, [busyTask, editor, onActivate, origin, platform, tabId, temporary]);

  const restoreTask = useEffectEvent((editor: MintEditor, request: WritingTaskOpenRequest) => {
    const { task, returnToTab } = request;
    if (taskRunning.current || temporary) {
      request.complete(temporary ? "temporary" : false);
      return;
    }
    const mapper = mapReviewRanges(task.baseline, editor.getText());
    setOrigin({
      id: task.id,
      editor,
      text: task.origin.text,
      range: restoreRange(editor, mapper.range(task.origin)),
      folder: task.folder,
    });
    setRestored({ task, mapper, restoreReading: returnToTab === undefined });
    setPlacement("sidebar");
    if (returnToTab !== undefined) setReviewStart({ id: task.id, returnToTab });
    request.complete(true);
  });
  useEffect(() => {
    if (!editor || !taskRestore || lastRestore.current === taskRestore) return;
    lastRestore.current = taskRestore;
    restoreTask(editor, taskRestore);
  }, [editor, taskRestore]);

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
        <div className="absolute right-4 bottom-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap justify-end gap-2">
          {hasSavedTasks && (
            <button type="button" className={buttonClass} onClick={onTasks}>
              {t("writing.tasks")}
            </button>
          )}
          {origin && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => setPlacement(restored ? "sidebar" : "inline")}
            >
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
          path={path}
          name={name}
          placement={placement}
          reviewStart={reviewStart?.id === origin.id ? reviewStart : null}
          setPlacement={setPlacement}
          active={active}
          taskRunning={taskRunning}
          platform={platform}
          folder={folder}
          settingsOpen={settingsOpen}
          onSettings={onSettings}
          externalChange={externalChange}
          refreshDisk={refreshDisk}
          restored={restored}
          temporary={temporary}
          onTemporaryChange={setTemporary}
          onEndTemporary={() => {
            setTemporary(false);
            setPlacement(null);
            setOrigin(null);
          }}
          onSaved={() => {
            if (!origin.folder) setHasSavedTasks(true);
          }}
          onTasks={onTasks}
          onOpenReview={onOpenReview}
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
  reviewStart,
  setPlacement,
  taskRunning,
  active,
  platform,
  folder,
  settingsOpen,
  onSettings,
  externalChange,
  refreshDisk,
  restored,
  temporary,
  onTemporaryChange,
  onEndTemporary,
  onSaved,
  onTasks,
  onOpenReview,
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
  | "onOpenReview"
  | "onTasks"
  | "externalChange"
  | "refreshDisk"
> & {
  readonly origin: Origin;
  readonly restored: RestoredReview | null;
  readonly temporary: boolean;
  readonly onTemporaryChange: (temporary: boolean) => void;
  readonly onEndTemporary: () => void;
  readonly onSaved: () => void;
  readonly onBusyChange: (id: string | null) => void;
  readonly placement: "inline" | "sidebar" | null;
  readonly reviewStart: { readonly returnToTab: number } | null;
  readonly taskRunning: { current: boolean };
  readonly setPlacement: (placement: "inline" | "sidebar" | null) => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<Scope>(origin.folder ? "folder" : "selection");
  const [actionOverride, setActionOverride] = useState<Action | null>(null);
  const [includeDraft, setIncludeDraft] = useState(false);
  const [allowedFolder, setAllowedFolder] = useState<string | null>(null);
  const searchFolder =
    allowedFolder === folder && (!origin.folder || origin.folder === folder) ? folder : null;
  const named = useNamedMaterials();
  const materialRequests = useMaterialRequests();
  const [includeHistory, setIncludeHistory] = useState(true);
  const [recipients, setRecipients] = useState<readonly WritingRecipient[]>([]);
  const [recipientId, setRecipientId] = useState<string | null>(
    restored?.task.pending?.recipientId ?? restored?.task.turns.at(-1)?.recipientId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [title, setTitle] = useState(restored?.task.title ?? "");
  const [confirmTemporaryClose, setConfirmTemporaryClose] = useState(false);
  const [closingTemporary, setClosingTemporary] = useState(false);
  const [temporaryCleanupFailed, setTemporaryCleanupFailed] = useState(false);
  const temporaryAgentCopy = useRef(false);
  const finishTabClose = useRef<((allow: boolean) => void) | null>(null);
  const savedAt = useRef(restored?.task.updatedAt);
  const [ready, setReady] = useState(!restored);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [retryId, setRetryId] = useState("");
  const controller = useRef<AbortController | null>(null);
  const busy = attempt?.status === "working" || attempt?.status === "approval";
  const store = useTabStore();
  const [error, setError] = useState<"sendFailed" | "agentChanged" | "missingSelection" | "visionRequired" | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const review = useRef<HTMLElement>(null);
  const reviewScroll = useRef(restored?.task.reviewScroll ?? 0);
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(restored?.task.pending);
  const heading = useRef<HTMLSpanElement>(null);
  const openingChanges = useRef(false);
  const mounted = useRef(true);
  const isActive = useRef(active);
  isActive.current = active;
  const checkingDisk = useRef(false);
  const trackedSuggestions = useRef(new Set<TrackedRange>());
  const [showSource, setShowSource] = useState(restored?.task.showSource ?? false);
  const [reviewSelection, setReviewSelection] = useState(restored?.task.reviewSelection);
  const [focusedReview, setFocusedReview] = useState(false);
  const returnTab = useRef(tabId);
  const reading = useRef<ReturnType<MintEditor["captureReadingPosition"]> | null>(null);
  const [draft, setDraft] = useState(() => origin.editor.getText());
  const recipient = recipients.find((candidate) => candidate.id === recipientId);
  const checkVision = useModelVision(platform.sendModelMessage);
  const visionFor = (candidate?: WritingRecipient) =>
    checkVision(candidate?.kind === "model" ? { id: candidate.id, connection: { id: candidate.modelId } } : undefined);
  const vision = visionFor(recipient);
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

  const capacity = useMaterialCapacity({
    recipient: recipient && labelFor(recipient),
    selectedText,
    draft: currentDraft,
    entries: named.entries,
    folderSearch: !!searchFolder,
    editing: action !== "comment",
  });

  const snapshot = useCallback(
    (taskTitle: string): SavedWritingTask => {
      const editor = origin.editor;
      return {
        version: 1,
        id: origin.id,
        path,
        folder: origin.folder,
        title: taskTitle,
        updatedAt: Date.now(),
        baseline: editor.getText(),
        origin: { ...savedRange(origin.range), text: origin.text },
        reading: reading.current?.current() ?? {
          ...editor.getSelection(),
          top: editor.getVisibleRange().from,
        },
        reviewScroll: reviewScroll.current,
        reviewSelection,
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
    [origin, path, reviewSelection, showSource, turns],
  );

  const persist = useCallback(
    (taskTitle = title) => {
      if (temporary || !taskTitle || !ready) return;
      const record = snapshot(taskTitle);
      void writeTaskCheckpoint(platform.writingTasks, async () => {
        const previous = savedAt.current;
        if (previous === undefined) return;
        const updatedAt = Math.max(previous + 1, record.updatedAt);
        await platform.writingTasks.update({ ...record, updatedAt }, previous);
        savedAt.current = updatedAt;
      }).then(
        () => {
          if (mounted.current) setSaveFailed(false);
        },
        () => {
          if (mounted.current) setSaveFailed(true);
        },
      );
    },
    [platform, ready, snapshot, temporary, title],
  );

  const saveCheckpoint = useEffectEvent(persist);
  const saveReadingSoon = useEffectEvent(() => queueReadingSave());
  const flushReadingCheckpoint = useEffectEvent(() => {
    if (readingTimer.current === null) return;
    clearTimeout(readingTimer.current);
    readingTimer.current = null;
    persist();
  });

  function queueReadingSave() {
    if (temporary || !title || !ready) return;
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
      if (restored.restoreReading) {
        origin.editor.restoreReadingPosition({
          anchor: mapper.point(task.reading.anchor),
          head: mapper.point(task.reading.head),
          top: mapper.point(task.reading.top),
        });
      }
      if (review.current) review.current.scrollTop = reviewScroll.current;
      setReady(true);
    }
    return () => {
      mounted.current = false;
      flushReadingCheckpoint();
      taskRunning.current = false;
      controller.current?.abort();
      reading.current?.release();
      reading.current = null;
      for (const range of tracked) range.release();
      tracked.clear();
    };
  }, [origin, restored, taskRunning]);

  useEffect(() => {
    persist();
  }, [persist]);

  useEffect(() => {
    onBusyChange(busy ? origin.id : null);
    return () => onBusyChange(null);
  }, [busy, onBusyChange, origin.id]);

  useEffect(() => {
    if (!temporary) return;
    const unregister = store.registerCloseGuard(tabId, () => {
      if (finishTabClose.current) return Promise.resolve(false);
      store.activate(tabId);
      setPlacement("sidebar");
      setConfirmTemporaryClose(true);
      return new Promise((resolve) => {
        finishTabClose.current = resolve;
      });
    });
    return () => {
      unregister();
      finishTabClose.current?.(false);
      finishTabClose.current = null;
    };
  }, [setPlacement, store, tabId, temporary]);

  useEffect(() => {
    if (!active || !placement) return;
    const unregister = registerTaskCheckpoint(platform.writingTasks, () => saveCheckpoint());
    const unsubscribe = origin.editor.subscribe(({ type }) => {
      if (type === "selection") saveCheckpoint();
      if (type === "scroll") saveReadingSoon();
    });
    return () => {
      unregister();
      unsubscribe();
      flushReadingCheckpoint();
    };
  }, [active, origin, placement, platform]);

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
    if (!placement || !isActive.current || settingsOpen) return;
    if (openingChanges.current) {
      heading.current?.focus();
      openingChanges.current = false;
    } else if (restored) {
      review.current?.focus({ preventScroll: true });
    } else {
      input.current?.focus();
    }
  }, [placement, restored, settingsOpen]);

  function viewChanges() {
    openingChanges.current = placement !== "sidebar";
    setPlacement("sidebar");
  }

  function close() {
    if (temporary) {
      setConfirmTemporaryClose(true);
      return;
    }
    persist();
    setPlacement(null);
    origin.editor.focus();
  }

  function finishTemporaryClose(confirmed: boolean) {
    const finish = finishTabClose.current;
    finishTabClose.current = null;
    setConfirmTemporaryClose(false);
    if (confirmed) {
      onEndTemporary();
      if (!finish) requestAnimationFrame(() => store.editor(tabId)?.focus());
    }
    finish?.(confirmed);
  }

  async function endTemporarySession() {
    if (controller.current || checkingDisk.current || closingTemporary) return;
    setClosingTemporary(true);
    setTemporaryCleanupFailed(false);
    try {
      if (temporaryAgentCopy.current) await platform.writingTasks.removeTemporary(origin.id);
      finishTemporaryClose(true);
    } catch {
      setTemporaryCleanupFailed(true);
    } finally {
      setClosingTemporary(false);
    }
  }

  function openFocusedReview(returnToTab = tabId) {
    returnTab.current = returnToTab;
    reading.current ??= origin.editor.captureReadingPosition();
    setFocusedReview(true);
  }

  const startFocusedReview = useEffectEvent(openFocusedReview);
  useEffect(() => {
    if (ready && reviewStart) startFocusedReview(reviewStart.returnToTab);
  }, [ready, reviewStart]);

  function closeFocusedReview(returnToOriginal = true) {
    persist();
    reading.current?.restore();
    reading.current?.release();
    reading.current = null;
    setFocusedReview(false);
    setPlacement(temporary && returnToOriginal ? "sidebar" : null);
    if (returnToOriginal) {
      const id = returnTab.current;
      if (id !== tabId && store.getState().tabs.some((tab) => tab.id === id)) store.activate(id);
      else origin.editor.focus();
    }
  }

  async function switchReview({ id, path }: SavedReviewLink) {
    const tasks = platform.writingTasks;
    await writingTaskWrites(tasks);
    const task = (await tasks.list(path, true)).find(
      (task) => task.id === id && task.path === path,
    );
    if (!task) return false;
    const result = await onOpenReview(task, returnTab.current);
    if (result === true) closeFocusedReview(false);
    return result;
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

  function recordReversionDecision(ranges: readonly TrackedRange[], status: "reverted" | "kept") {
    const decided = new Set(ranges);
    setTurns((previous) =>
      previous.map((turn) => ({
        ...turn,
        suggestions: turn.suggestions?.map((suggestion) =>
          decided.has(suggestion.range) ? { ...suggestion, status } : suggestion,
        ),
      })),
    );
  }

  function keepCurrent(range: TrackedRange) {
    if (busy || checkingDisk.current || !trackedSuggestions.current.has(range)) return;
    recordReversionDecision([range], "kept");
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

  async function revertEdits(suggestions: readonly Suggestion[], compared?: string) {
    if (busy || checkingDisk.current) return;
    checkingDisk.current = true;
    try {
      if (!(await refreshDisk()) || !mounted.current) {
        if (mounted.current) viewChanges();
        return;
      }
      const live = origin.editor.getText();
      let needsComparison = false;
      const replacements: (TextRange & { text: string; range: TrackedRange })[] = [];
      const laterEdits: TextRange[] = [];
      // If two turns touched the same text, consider the latest edit first.
      for (const suggestion of suggestions.toReversed()) {
        const { appliedText, range, before } = suggestion;
        if (!trackedSuggestions.current.has(range) || !isApplied(suggestion, live)) continue;
        const { from, to } = range.current();
        const overlaps = laterEdits.some((other) =>
          from === to || other.from === other.to
            ? from <= other.to && other.from <= to
            : from < other.to && other.from < to,
        );
        laterEdits.push({ from, to });
        if (
          !range.hasBoundaries() ||
          live.slice(from, to) !== (compared ?? appliedText) ||
          overlaps
        ) {
          needsComparison = true;
          continue;
        }
        replacements.push({ from, to, text: before, range });
      }
      if (replacements.length > 0) {
        replacements.sort((left, right) => left.from - right.from);
        origin.editor.replaceRanges(replacements, { lineEndings: "preserve" });
        recordReversionDecision(
          replacements.map(({ range }) => range),
          "reverted",
        );
      }
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
    keepReviewFocus = false,
  ) {
    if (busy || checkingDisk.current || reviewStatus(suggestion, draft) !== "preview") return false;
    let update: Partial<Suggestion> = { status: "discarded", batchApplied: false };
    if (acceptedText !== undefined) {
      checkingDisk.current = true;
      try {
        if (!(await refreshDisk()) || !mounted.current || !suggestion.range.hasBoundaries())
          return false;
        const range = suggestion.range.current();
        if (origin.editor.getText().slice(range.from, range.to) !== acceptedText) return false;
        update = { status: "applied", batchApplied: false };
        if (acceptedText !== suggestion.after) {
          const [inserted] = origin.editor.replaceRanges([{ ...range, text: suggestion.after }], {
            collapseSelection: range,
            lineEndings: "match",
          });
          if (inserted) {
            const edited = origin.editor.getText();
            update = recordApplied(
              { ...suggestion, batchApplied: false },
              inserted,
              edited.slice(inserted.from, inserted.to),
              acceptedText,
            );
          }
        }
        if (isActive.current && !keepReviewFocus) origin.editor.focus();
      } finally {
        checkingDisk.current = false;
      }
    }
    updateSuggestion(index, position, update);
    return true;
  }

  async function acceptSection(entries: readonly ReviewEntry[]) {
    if (busy || checkingDisk.current) return 0;
    checkingDisk.current = true;
    try {
      if (!(await refreshDisk()) || !mounted.current || !reading.current) return 0;
      const editor = origin.editor;
      const live = editor.getText();
      const eligible = entries.flatMap(({ turn, position }) => {
        const item = turns[turn]?.suggestions?.[position];
        if (
          !item ||
          item.note ||
          reviewStatus(item, live) !== "preview" ||
          !item.range.hasBoundaries() ||
          currentText(item, live) !== item.before
        )
          return [];
        return [{ ...item.range.current(), text: item.after, item }];
      });
      // Different replies can propose edits to the same passage. Leave overlapping
      // proposals pending for individual comparison.
      let end = -1;
      eligible.sort((a, b) => a.from - b.from);
      const replacements = eligible.filter(({ from, to }, index) => {
        const overlapsEarlier = from < end || from === eligible[index - 1]?.from;
        end = Math.max(end, to);
        const next = eligible[index + 1]?.from;
        return !overlapsEarlier && (next === undefined || (next >= to && next !== from));
      });
      const ranges = editor.replaceRanges(replacements, { lineEndings: "match" });
      const edited = editor.getText();
      const updates = new Map<Suggestion, Suggestion>();
      for (const [index, { item }] of replacements.entries()) {
        const range = ranges[index];
        if (!range) continue;
        const applied = recordApplied(item, range, edited.slice(range.from, range.to));
        updates.set(item, { ...applied, batchApplied: true });
      }
      setTurns((previous) =>
        previous.map((turn) => ({
          ...turn,
          suggestions: turn.suggestions?.map((item) => updates.get(item) ?? item),
        })),
      );
      return updates.size;
    } finally {
      checkingDisk.current = false;
    }
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
      !capacity.plan ||
      busy ||
      loading ||
      named.loading ||
      named.unconfirmed ||
      (named.hasImages && !vision?.verified) ||
      (scope === "folder" && !searchFolder) ||
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
    const history = includeHistory
      ? turns.flatMap(({ status, instruction, reply, suggestions }) => [
          ...((status ?? "complete") === "complete" && reply ? [{ instruction, reply }] : []),
          ...(suggestions?.flatMap(
            ({ comments }) =>
              comments?.map(({ instruction, reply }) => ({ instruction, reply })) ?? [],
          ) ?? []),
        ])
      : [];
    const task: Task = {
      plan: capacity.plan,
      request: {
        instruction: instruction.trim(),
        selectedText: capacity.plan.selectedText,
        taskContext: capacity.plan.contexts[0],
        history: history.length ? history : undefined,
        responseFormat: action === "comment" ? undefined : "replacement",
      },
      action,
      scope,
      searchFolder,
      seen: new Set(),
    };
    if (placement === "inline") origin.editor.focus();
    await runTask(task, recipient, () => {
      setInstruction("");
      setActionOverride(null);
      setAllowedFolder(null);
    });
  }

  async function runTask(task: Task, connection: WritingRecipient, onSavedRequest?: () => void) {
    if (controller.current || checkingDisk.current) return false;
    if (hasTaskImages(...(task.plan?.contexts ?? [task.request.taskContext])) && !visionFor(connection)?.verified) {
      setError("visionRequired");
      return false;
    }
    const running = new AbortController();
    const { signal } = running;
    controller.current = running;
    taskRunning.current = true;
    const recipient = labelFor(connection);
    const entry = { id: crypto.randomUUID(), task, recipientId: connection.id, recipient };
    const submitted = {
      instruction: task.request.instruction,
      material: task.request.selectedText ?? task.request.taskContext?.currentDraft?.text,
      context: task.request.taskContext,
      searchFolder: task.searchFolder ?? undefined,
      recipient,
      recipientId: connection.id,
    };
    const editing = task.action !== "comment";
    let text = "";
    let approved: NamedMaterial[] = [];
    let status: AttemptStatus;
    let finalReplacement: string | undefined;
    let capacityRejected = false;
    setRetryId("");
    setError(null);
    setAttempt({ ...entry, approved, status: "working", partial: "" });

    const taskTitle = title || submitted.instruction;
    pending.current = submitted;
    if (temporary) {
      setTitle(taskTitle);
    } else if (title) persist();
    else {
      try {
        const record = snapshot(taskTitle);
        await writeTaskCheckpoint(platform.writingTasks, () =>
          platform.writingTasks.create(record),
        );
        savedAt.current = record.updatedAt;
      } catch {
        pending.current = undefined;
        controller.current = null;
        taskRunning.current = false;
        if (mounted.current) {
          setAttempt(attempt);
          setSaveFailed(true);
        }
        return false;
      }
      if (!mounted.current) return false;
      setTitle(taskTitle);
      setSaveFailed(false);
      onSaved();
    }
    let sentContext = submitted.context;
    try {
      if (temporary && connection.kind === "agent") {
        temporaryAgentCopy.current = true;
        await platform.writingTasks.createTemporary(origin.id);
      }
      const result = await materialRequests.send(
        connection.send,
        task.request,
        recipient,
        task.searchFolder,
        {
          taskId: origin.id,
          signal,
          plan: task.plan,
          onContext: (context) => {
            sentContext = context;
            pending.current = { ...submitted, context };
            persist(taskTitle);
          },
          onApproval: (completed) => {
            text = completed;
            setAttempt({ ...entry, approved, status: "approval", partial: "" });
          },
          onResume: (decision, completed) => {
            text = completed;
            if (decision?.outcome === "allowed") approved = [...approved, decision.material];
            if (!signal.aborted)
              setAttempt({ ...entry, approved, status: "working", partial: text });
          },
          onProgress: (progress) => {
            if (signal.aborted) return;
            text = progress;
            setAttempt({ ...entry, approved, status: "working", partial: text });
          },
        },
      );
      text = result.text;
      status = signal.aborted ? "stopped" : replyStatus(result);
      if (editing && status === "complete") finalReplacement = replacementFromReply(result);
    } catch (problem) {
      status = failureStatus(problem, signal);
      capacityRejected = !signal.aborted && !!task.plan && isMaterialCapacityError(problem);
      if (mounted.current) {
        if (capacityRejected) capacity.reject(recipient);
        else if (status === "failed") reportSendError(problem);
      }
    }
    if (!mounted.current) return false;

    if (!capacityRejected) onSavedRequest?.();
    else if (onSavedRequest) setActionOverride(task.action);
    if (signal.aborted) status = "stopped";
    const canApplyDirectly =
      status === "complete" && task.action === "direct" && task.seen.size === 0;
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
                  if (
                    position !== rewrite.position ||
                    reviewStatus(suggestion, origin.editor.getText()) !== "preview"
                  )
                    return suggestion;
                  if (
                    replacement !== undefined &&
                    (newEdits?.length || (status === "complete" && edits?.length === 0))
                  ) {
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
    pending.current = undefined;
    if (partial || (!rewrite && (!capacityRejected || replacement !== undefined)))
      setTurns((previous) => [
        ...previous,
        {
          ...submitted,
          context: sentContext,
          reply: rewrite ? "" : status === "complete" ? (replacement ?? text) : (replacement ?? ""),
          direct: task.action === "direct",
          suggestions,
          status,
          partial,
        },
      ]);
    else if (!rewrite) persist(taskTitle);
    setAttempt({
      ...entry,
      approved,
      status,
      partial: "",
      newDecisions: suggestions?.filter(({ status }) => status === "preview").length,
      capacityRejected,
    });
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
  const pendingApproval = materialRequests.pending;
  const decisions = turns.reduce(
    (total, turn) =>
      total + (turn.suggestions?.filter(({ status }) => status === "preview").length ?? 0),
    Number(!!pendingApproval),
  );
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
            id: origin.id,
            tabId,
            title: title || attempt.task.request.instruction,
            name,
            folder: origin.folder,
            recipient: sendingTo,
            material: materials,
            status,
            count,
            decisions,
            background: !active || !placement,
            notice: pendingApproval
              ? {
                  id: `${attempt.id}:approval:${pendingApproval.id}`,
                  detail: pendingApproval.name,
                  decisions: 1,
                }
              : status === "complete"
                ? { id: attempt.id, decisions: attempt.newDecisions }
                : undefined,
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
    [
      active,
      attempt,
      count,
      decisions,
      materials,
      name,
      origin,
      pendingApproval,
      placement,
      sendingTo,
      setPlacement,
      status,
      store,
      tabId,
      title,
    ],
  );
  useWritingTask(report);
  // biome-ignore lint/correctness/useExhaustiveDependencies: document edits can move section headings.
  const sections = useMemo(() => {
    if (!focusedReview) return [];
    const parents: { level: number; text: string }[] = [];
    return origin.editor.getOutline().map(({ level, text, from }, index) => {
      while (parents.length && (parents.at(-1)?.level ?? 0) >= level) parents.pop();
      parents.push({ level, text });
      return { id: String(index), name: parents.map((heading) => heading.text).join(" › "), from };
    });
  }, [focusedReview, origin.editor, draft]);

  const canRetry = attempt && !busy && !attempt.capacityRejected && attempt.status !== "complete";
  const sameConnection = canRetry && recipients.find(({ id }) => id === attempt.recipientId);
  const otherConnection = canRetry && recipients.find(({ id }) => id === retryId);
  const retryHasImages =
    !!canRetry && hasTaskImages(...(attempt.task.plan?.contexts ?? [attempt.task.request.taskContext]));
  const sameVision = visionFor(sameConnection || undefined);
  const otherVision = visionFor(otherConnection || undefined);
  if (!placement) return null;
  const sidebar = placement === "sidebar";
  const latest = turns.at(-1);
  const closeLabel = t(temporary ? "writing.temporary.close" : "settings.close");
  const closeConfirmation = confirmTemporaryClose && (
    <TemporarySessionClose
      busy={busy}
      closing={closingTemporary}
      failed={temporaryCleanupFailed}
      onCancel={() => finishTemporaryClose(false)}
      onReview={
        !sidebar && latest?.suggestions?.length
          ? () => {
              finishTemporaryClose(false);
              viewChanges();
            }
          : undefined
      }
      onConfirm={() => void endTemporarySession()}
    />
  );
  if (focusedReview) {
    const entries = turns
      .flatMap((turn, index) =>
        (turn.suggestions ?? []).map((suggestion, position): ReviewEntry & { from: number } => {
          const { from } = suggestion.range.current();
          const located = suggestion.range.hasBoundaries();
          const section = located ? sections.findLast((heading) => heading.from <= from) : null;
          return {
            key: `${index}:${suggestion.id}`,
            turn: index,
            position,
            from,
            before: suggestion.before,
            after: suggestion.after,
            current: currentText(suggestion, draft),
            status: reviewStatus(suggestion, draft),
            note: suggestion.note,
            section: section ?? {
              id: located ? "intro" : "unlocated",
              name: t(
                !located
                  ? "writing.review.unlocated"
                  : sections.length
                    ? "writing.review.intro"
                    : "writing.scope.document",
              ),
            },
            blocked: externalChange ? "disk" : !located ? "boundaries" : undefined,
          };
        }),
      )
      .sort((a, b) => a.from - b.from);
    const review = (
      <FocusedWritingReview
        entries={entries}
        file={name}
        path={path}
        folder={folder && (!path || isWithin(path, folder)) ? folder : path && parentPath(path)}
        tasks={platform.writingTasks}
        onOpenFile={switchReview}
        initialSelection={reviewSelection}
        onSelection={setReviewSelection}
        onCompare={({ turn, position }) => {
          const range = turns[turn]?.suggestions?.[position]?.range;
          if (!range?.hasBoundaries()) return null;
          const target = range.current();
          const surrounding = origin.editor.getComparisonBlock(target);
          if (!surrounding) return null;
          return {
            kind: surrounding.kind,
            prefix: draft.slice(surrounding.from, target.from),
            suffix: draft.slice(target.to, surrounding.to),
          };
        }}
        source={showSource}
        busy={busy}
        onSource={setShowSource}
        onLocate={({ turn, position }) => {
          const range = turns[turn]?.suggestions?.[position]?.range;
          if (range?.hasBoundaries()) {
            const { from, to } = range.current();
            origin.editor.setSelection({ anchor: from, head: to, scrollIntoView: "start" });
          }
        }}
        onDecide={({ turn, position, current }, accept) => {
          const suggestion = turns[turn]?.suggestions?.[position];
          return suggestion
            ? decide(turn, position, suggestion, accept ? current : undefined, true)
            : Promise.resolve(false);
        }}
        onAcceptSection={acceptSection}
        onRestore={({ turn, position }) => updateSuggestion(turn, position, { status: "preview" })}
        onComment={({ turn, position }, note) => updateSuggestion(turn, position, { note })}
        onClose={() => closeFocusedReview()}
      />
    );
    return (
      <>
        {review}
        {closeConfirmation}
      </>
    );
  }
  if (
    !sidebar &&
    !busy &&
    (latest?.status ?? "complete") === "complete" &&
    latest?.direct &&
    latest.suggestions?.length
  ) {
    const { suggestions } = latest;
    const applied = suggestions.filter((suggestion) => isApplied(suggestion, draft)).length;
    const pending = suggestions.filter((item) => reviewStatus(item, draft) === "preview").length;
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
        {pending > 0 && (
          <button type="button" className={buttonClass} onClick={() => openFocusedReview()}>
            {t("writing.review.title")}
          </button>
        )}
        {applied > 0 && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => void revertEdits(suggestions)}
          >
            {t("writing.edit.undoDirect")}
          </button>
        )}
        <button type="button" className={buttonClass} onClick={close}>
          {closeLabel}
        </button>
        {closeConfirmation}
      </section>
    );
  }
  const Container = sidebar ? "aside" : "section";
  const messages = sidebar ? turns : turns.slice(-1);
  const taskEdits = sidebar ? turns.flatMap((turn) => turn.suggestions ?? []) : [];

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

  function renderSentContext(context: TaskContext | undefined, searchFolder?: string) {
    if (!context) return null;
    const materials = contextMaterials(context);
    return (
      <fieldset className="space-y-1 rounded border border-(--mint-border) p-2 text-xs">
        <legend className="px-1">{t("writing.tasks.sentContext")}</legend>
        {context.folderSearch && (
          <p className="wrap-anywhere">
            {t("writing.tasks.searchedFolder", { folder: searchFolder ?? "" })}
          </p>
        )}
        {materials.map((material, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A turn keeps its original material order, including duplicates.
          <details key={`${index}:${material.name}`} className="wrap-anywhere">
            <summary>{materialLabel(material, t)}</summary>
            <MaterialPreview material={material} />
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
        if (event.key === "Escape" && !confirmTemporaryClose && !event.nativeEvent.isComposing) {
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
        <span ref={heading} tabIndex={-1} className="font-medium">
          {t(sidebar ? "writing.title" : "writing.ask")}
        </span>
        <div className="flex gap-2">
          {temporary && <span className="self-center text-xs">{t("writing.temporary.label")}</span>}
          {title && !temporary && (
            <button type="button" className={buttonClass} onClick={onTasks}>
              {t("writing.tasks")}
            </button>
          )}
          <button type="button" className={buttonClass} onClick={close}>
            {closeLabel}
          </button>
        </div>
      </header>
      {sidebar && (
        <>
          <span className="wrap-anywhere">
            {origin.folder ? t("writing.tasks.folder", { folder: origin.folder }) : name}
          </span>
          {!origin.folder && origin.text && (
            <>
              <button type="button" className={buttonClass} onClick={locate}>
                {t("writing.locate")}
              </button>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2">
                {origin.text}
              </pre>
            </>
          )}
        </>
      )}
      {taskEdits.some((suggestion) => isApplied(suggestion, draft)) && (
        <button
          type="button"
          className={`${buttonClass} self-start`}
          disabled={busy}
          onClick={() => void revertEdits(taskEdits)}
        >
          {t("writing.edit.revertAll")}
        </button>
      )}
      {sidebar && attempt && (
        <WritingTaskMaterials
          request={attempt.task.request}
          approved={attempt.approved}
          folder={attempt.task.searchFolder}
        />
      )}
      {messages.some((turn) => turn.suggestions?.length) && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} onClick={() => openFocusedReview()}>
            {t("writing.review.title")}
          </button>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showSource}
              onChange={(event) => setShowSource(event.target.checked)}
            />
            {t("writing.edit.source")}
          </label>
        </div>
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
              {sidebar && renderSentContext(turn.context, turn.searchFolder)}
              {suggestions?.length ? (
                suggestions.map((suggestion, position) => {
                  const status = reviewStatus(suggestion, draft);
                  const pending = status === "preview";
                  const revertible = !pending && canRevert(suggestion);
                  const current = pending || revertible ? currentText(suggestion, draft) : "";
                  const conflict = pending && current !== suggestion.before;
                  const located = suggestion.range.hasBoundaries();
                  const reverted = revertible && located && current === suggestion.before;
                  const revertConflict =
                    revertible && !reverted && (!located || current !== suggestion.appliedText);
                  const blocked = externalChange ? "disk" : !located ? "boundaries" : undefined;
                  return (
                    <ProposedSelectionEdit
                      key={suggestion.id}
                      label={t("writing.edit.position", {
                        index: String(position + 1),
                        total: String(suggestions.length),
                      })}
                      before={suggestion.before}
                      after={suggestion.appliedText ?? suggestion.after}
                      status={reverted ? "reverted" : status}
                      showAppliedComparison={revertible}
                      source={showSource}
                      current={conflict || revertConflict ? current : undefined}
                      blocked={pending || (revertible && !reverted) ? blocked : undefined}
                      busy={busy}
                      recipient={turn.recipient}
                      conversation={
                        <>
                          {suggestion.note && (
                            <p className="whitespace-pre-wrap wrap-anywhere">{suggestion.note}</p>
                          )}
                          {suggestion.comments?.map(({ id, instruction, reply }) => (
                            <div key={id} className="rounded bg-(--mint-hover) p-2">
                              <p className="font-medium">{instruction}</p>
                              {renderReplyExcerpt(reply)}
                            </div>
                          ))}
                        </>
                      }
                      onApply={
                        blocked || !pending
                          ? undefined
                          : () => void decide(index, position, suggestion, current)
                      }
                      onDiscard={
                        pending ? () => void decide(index, position, suggestion) : undefined
                      }
                      onRevert={
                        revertible && !reverted && !blocked
                          ? () => void revertEdits([suggestion], current)
                          : undefined
                      }
                      onKeepCurrent={
                        revertConflict ? () => keepCurrent(suggestion.range) : undefined
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
        {sidebar && restored && pending.current && !busy && (
          <article className="space-y-1">
            <p>{pending.current.instruction}</p>
            <p>{pending.current.recipient}</p>
            {pending.current.material !== undefined && (
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere">
                {pending.current.material}
              </pre>
            )}
            {renderSentContext(pending.current.context, pending.current.searchFolder)}
          </article>
        )}
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
          {retryHasImages && sameVision && !sameVision.verified && <VisionControl check={sameVision} />}
          <button
            type="button"
            className={buttonClass}
            disabled={!sameConnection || busy || (retryHasImages && !sameVision?.verified)}
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
              {attempt.task.plan && otherConnection && (
                <MaterialPlanPreview
                  plan={attempt.task.plan}
                  recipient={labelFor(otherConnection)}
                />
              )}
              {retryHasImages && otherVision && <VisionControl check={otherVision} />}
              {retryHasImages && otherConnection && !otherVision && (
                <p role="alert">{t("materials.visionRequired")}</p>
              )}
              <button
                type="button"
                className={buttonClass}
                disabled={!otherConnection || busy || (retryHasImages && !otherVision?.verified)}
                onClick={() => otherConnection && void runTask(attempt.task, otherConnection)}
              >
                {t("writing.task.retryOther")}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">{t(
            error === "agentChanged" ? "agent.reviewAgain"
              : error === "visionRequired" ? "materials.visionRequired"
                : `writing.${error}`,
          )}</p>
      )}
      {saveFailed && <p role="alert">{t("writing.tasks.saveFailed")}</p>}
      {!sidebar && turns.length > 0 && !attempt?.capacityRejected ? (
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
                  {(origin.folder ? (["folder"] as const) : scopes).map((id) => (
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
            {!title && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={temporary}
                  onChange={(event) => onTemporaryChange(event.target.checked)}
                />
                {t("writing.temporary.label")}
              </label>
            )}
            <TaskContextChecklist
              platform={platform}
              named={named}
              recipient={recipient && labelFor(recipient)}
              vision={vision}
              selection={selectedText}
              draft={currentDraft}
              includeDraft={scope === "selection" ? setIncludeDraft : undefined}
              handlingFull={capacity.method === "full"}
              folder={origin.folder && origin.folder !== folder ? null : folder}
              searchEnabled={!!searchFolder}
              onSearchChange={(checked) => setAllowedFolder(checked ? folder : null)}
            />
            {capacity.controls}
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
                disabled={
                  !recipient ||
                  !capacity.plan ||
                  loading ||
                  !instruction.trim() ||
                  named.loading ||
      named.unconfirmed ||
      (named.hasImages && !vision?.verified) ||
                  (scope === "folder" && !searchFolder)
                }
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
          vision={visionFor(recipients.find(({ id }) => id === attempt?.recipientId))}
          onDecision={(decision) => {
            materialRequests.decide(decision);
            if (active && attempt?.task.action === "direct") origin.editor.focus();
          }}
        />
      )}
      {closeConfirmation}
    </Container>
  );
}

function TemporarySessionClose({
  busy,
  closing,
  failed,
  onCancel,
  onReview,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly closing: boolean;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onReview?: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onCancel);
  const description = useId();
  return (
    <dialog
      {...props}
      onCancel={(event) => {
        if (closing) event.preventDefault();
        else props.onCancel(event);
      }}
      aria-label={t("writing.temporary.close")}
      aria-describedby={description}
      className="m-auto max-h-[85vh] w-[min(28rem,90vw)] space-y-3 overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) backdrop:bg-black/30"
    >
      <h2 className="font-medium">{t("writing.temporary.close")}</h2>
      <p id={description}>{t("writing.temporary.closePrompt")}</p>
      {busy && <p>{t("writing.temporary.wait")}</p>}
      {failed && <p role="alert">{t("writing.temporary.cleanupFailed")}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={closing} onClick={close}>
          {t("unsaved.cancel")}
        </button>
        {onReview && (
          <button type="button" className={buttonClass} disabled={closing} onClick={onReview}>
            {t("writing.viewChanges")}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          disabled={busy || closing}
          onClick={onConfirm}
        >
          {t("writing.temporary.close")}
        </button>
      </div>
    </dialog>
  );
}
