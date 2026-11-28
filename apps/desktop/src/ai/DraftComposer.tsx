import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useDialect } from "../settings/useDialect.ts";
import { useSettings } from "../settings/useSettings.ts";
import { useTabStore } from "../tabs/context.ts";
import { ExternalAgentAccessNotice } from "./ExternalAgentPanel.tsx";
import type { AgentAccess } from "./external-agent.ts";
import {
  type MaterialPlan,
  MaterialPlanPreview,
  useMaterialCapacity,
} from "./MaterialCapacity.tsx";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { useModelVision, VisionControl, type VisionTarget } from "./ModelVision.tsx";
import { isLocalModelOffline, modelEndpoint, modelWritingSender } from "./model.ts";
import { recordWritingResult } from "./record-writing-result.ts";
import {
  ExportWritingSkillButton,
  useSavedWritingSkills,
  WritingSkillChoices,
} from "./SavedWritingSkills.tsx";
import { SourcePassageReview } from "./SourcePassageReview.tsx";
import {
  savedSkillInstruction,
  type WritingMethod,
  type WritingSkillTool,
  writingSkillMaterials,
} from "./saved-writing-skills.ts";
import {
  draftText,
  hasSourceMaterials,
  readDraftPassages,
  type SourcePassage,
} from "./source-passages.ts";
import { materialDropHandlers, TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
import { TemporarySessionClose } from "./TemporarySessionClose.tsx";
import {
  useWritingCallLimit,
  WritingCallPause,
  WritingCallPlan,
  WritingReportedUsage,
  WritingRetryEstimate,
} from "./WritingCallLimit.tsx";
import {
  AppliedWritingPreferences,
  useWritingPreferences,
  WritingPreferences,
} from "./WritingPreferences.tsx";
import { WritingSkillDetails } from "./WritingSkillPlan.tsx";
import { useWritingTask, WritingTaskMaterials } from "./WritingTasks.tsx";
import {
  useWritingToolPicker,
  WritingToolNotice,
  WritingToolOutcome,
  WritingToolPicker,
  type WritingToolPlan,
} from "./WritingTool.tsx";
import {
  type AttemptStatus,
  failureStatus,
  isMaterialCapacityError,
  replyStatus,
  writingAttemptBusy,
  writingMaterialNames,
} from "./writing-attempt.ts";
import {
  effectiveWritingRecipient,
  loadWritingRecipients,
  type WritingRecipient,
  writingConnectionId,
  writingRecipientLabel,
} from "./writing-recipients.ts";
import {
  hasTaskImages,
  type NamedMaterial,
  type TaskContext,
  type WritingRequest,
  type WritingSender,
} from "./writing-sender.ts";
import { readWritingSkill } from "./writing-skills.ts";
import { mapReviewRanges } from "./writing-tasks.ts";

const field =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const button =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

interface DraftConnection {
  readonly id: string;
  readonly label: string;
  readonly send: WritingSender;
  readonly endpoint?: string;
  readonly visionTarget?: VisionTarget;
  readonly agentAccess?: AgentAccess;
}

interface DraftTask {
  readonly id: string;
  readonly title: string;
  readonly method: WritingMethod;
  readonly request: WritingRequest;
  readonly plan: MaterialPlan;
  readonly folder: string | null;
  readonly callLimit?: number;
  readonly replayRequests?: readonly (WritingRequest | undefined)[];
}

interface DraftAttempt {
  readonly id: string;
  readonly task: DraftTask;
  readonly connection: Omit<DraftConnection, "send">;
  readonly status: AttemptStatus;
  readonly partial: string;
  readonly approved: readonly NamedMaterial[];
  readonly capacityRejected?: boolean;
  readonly savedAtLimit?: boolean;
}

export function DraftComposer({
  platform,
  folder,
  tabId,
  name,
  active,
  settingsOpen,
  canApplyDraft,
  onDraft,
  onClose,
}: {
  readonly platform: Platform;
  readonly folder: string | null;
  readonly tabId: number;
  readonly name: string;
  readonly active: boolean;
  readonly settingsOpen: boolean;
  readonly canApplyDraft: () => boolean;
  readonly onDraft: (text: string) => boolean;
  readonly onClose: (tabId: number) => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const store = useTabStore();
  const controller = useRef<AbortController | null>(null);
  const retryConnection = useRef<DraftConnection | null>(null);
  const mounted = useRef(true);
  const [temporary, setTemporary] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const [revertConflict, setRevertConflict] = useState(false);
  const temporaryCopies = useRef(new Set<string>());
  const closeGuard = useRef<((confirmed: boolean) => void) | null>(null);
  const dialect = useDialect();
  const [collapsed, setCollapsed] = useState(false);
  const [attempt, setAttempt] = useState<DraftAttempt | null>(null);
  const [partials, setPartials] = useState<
    readonly { id: string; text: string; finished?: boolean }[]
  >([]);
  const [retryId, setRetryId] = useState("");
  const [instruction, setInstruction] = useState("");
  const preferences = useWritingPreferences(platform, folder);
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [recipients, setRecipients] = useState<readonly WritingRecipient[] | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const { settings } = useSettings();
  const busy = writingAttemptBusy(attempt?.status);
  const [error, setError] = useState<MessageKey | null>(null);
  const [unapplied, setUnapplied] = useState("");
  const [applied, setApplied] = useState<{
    text: string;
    passages: readonly SourcePassage[];
    context?: TaskContext;
    connection: DraftConnection;
  } | null>(null);
  const appliedReply = applied?.text ?? "";
  const [showAppliedReply, setShowAppliedReply] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const named = useNamedMaterials();
  const library = useSavedWritingSkills(platform);
  const draftSkills = library.skills.filter(
    ({ format, scope, action }) =>
      format === "draft" && scope === "instruction" && action === "direct",
  );
  const skill = readWritingSkill(instruction, draftSkills, false);

  function chooseSkill(value: string) {
    const next = readWritingSkill(value, draftSkills, false);
    if (next.custom && skill.id !== next.id) {
      setAllowedFolder(null);
      toolPicker.changeAddress("");
    }
    setInstruction(value);
  }
  const [allowedFolder, setAllowedFolder] = useState<string | null>(null);
  const searchFolder = allowedFolder === folder ? folder : null;
  const materialRequests = useMaterialRequests(platform.sendMcpRequest);
  const callLimit = useWritingCallLimit();
  const toolPicker = useWritingToolPicker(platform.sendMcpRequest);
  const toolApproval = materialRequests.externalTool;
  const defaultConnection = settings.defaultWritingConnection;
  const preferred = effectiveWritingRecipient(recipients ?? [], defaultConnection);
  const selected = choice ?? (preferred ? writingConnectionId(preferred) : defaultConnection);
  const saved = recipients?.find((item) => writingConnectionId(item) === selected);
  const agent = saved?.kind === "agent" ? saved : undefined;
  const custom = !selected;
  const unavailable = !custom && !saved;
  let endpoint = saved?.kind === "model" ? saved.endpoint : "";
  if (custom) {
    try {
      endpoint = modelEndpoint(address);
    } catch {
      // Sending stays unavailable until the endpoint is valid.
    }
  }
  const recipient = saved ? writingRecipientLabel(t, saved) : endpoint || undefined;

  const capacity = useMaterialCapacity({
    recipient,
    entries: named.entries,
    folderSearch: !!searchFolder,
  });
  const showCallPlan = named.entries.length > 0 || !!searchFolder || !!toolPicker.plan;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (store.getState().activeId === tabId && !collapsed && !settingsOpen) input.current?.focus();
  }, [collapsed, settingsOpen, store, tabId]);

  const hasAttempt = attempt !== null;
  useEffect(() => {
    if (!temporary) return;
    const unregister = store.registerCloseGuard(tabId, () => {
      if (!hasAttempt) return Promise.resolve(true);
      if (closeGuard.current) return Promise.resolve(false);
      store.activate(tabId);
      setCollapsed(false);
      setConfirmClose(true);
      return new Promise((resolve) => {
        closeGuard.current = resolve;
      });
    });
    return () => {
      unregister();
      closeGuard.current?.(false);
      closeGuard.current = null;
    };
  }, [hasAttempt, store, tabId, temporary]);

  useEffect(() => {
    if (!appliedReply || temporary) return;
    const editor = store.editor(tabId);
    return editor?.subscribe(({ type }) => {
      if (type !== "change") return;
      const tab = store.getState().tabs.find(({ id }) => id === tabId);
      if (tab?.path === null && editor.getText() === "") onClose(tabId);
    });
  }, [appliedReply, onClose, store, tabId, temporary]);

  useEffect(() => {
    if (settingsOpen) return;
    let current = true;
    void loadWritingRecipients(platform).then(({ available, failed }) => {
      if (!current) return;
      setRecipients(available);
      if (failed) setError("writing.connectionsFailed");
    });
    return () => {
      current = false;
    };
  }, [platform, settingsOpen]);

  const checkVision = useModelVision(platform.sendModelMessage);
  const inlineTarget: VisionTarget = useMemo(
    () => ({ id: crypto.randomUUID(), connection: { address, model }, apiKey: key }),
    [address, model, key],
  );
  const vision = checkVision(
    saved?.kind === "model"
      ? { id: saved.id, connection: { id: saved.modelId } }
      : custom && endpoint && model.trim()
        ? inlineTarget
        : undefined,
  );
  const canSend =
    recipients !== null &&
    preferences.available &&
    !!instruction.trim() &&
    !skill.suggestions?.length &&
    instruction.trim() !== "/" &&
    !toolPicker.incomplete &&
    (!showCallPlan || !callLimit.invalid) &&
    !named.loading &&
    !named.unconfirmed &&
    (!named.hasImages || vision?.verified === true) &&
    !!capacity.plan &&
    (!!saved || (custom && !!endpoint && !!model.trim()));

  const connections: DraftConnection[] = (recipients ?? []).map((item) => ({
    id: writingConnectionId(item),
    label: writingRecipientLabel(t, item),
    send: item.send,
    ...(item.kind === "model"
      ? { endpoint: item.endpoint, visionTarget: { id: item.id, connection: { id: item.modelId } } }
      : { agentAccess: item.access }),
  }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canSend || unapplied || !recipient || !capacity.plan) return;
    if (!canApplyDraft()) {
      setError("draft.requiresEmptyUntitled");
      return;
    }
    const connection = custom
      ? {
          id: "",
          label: recipient,
          endpoint,
          send: modelWritingSender(platform.sendModelMessage, inlineTarget.connection, {
            apiKey: key,
          }),
          visionTarget: inlineTarget,
        }
      : connections.find(({ id }) => id === selected);
    if (!connection) return;
    const tools: WritingSkillTool[] = named.entries.some(({ tool }) => tool === "zotero")
      ? [{ kind: "zotero" }]
      : [];
    const chosenTool = toolPicker.plan;
    if (chosenTool)
      tools.push({ kind: "mcp", name: chosenTool.tool.name, effect: chosenTool.effect });
    const prompt = skill.custom
      ? savedSkillInstruction(t, skill.custom, "direct", skill.instruction)
      : instruction.trim();
    await runDraft(
      {
        id: crypto.randomUUID(),
        title: instruction.trim(),
        method: {
          scope: "instruction",
          action: "direct",
          format: "draft",
          tools,
          materials: writingSkillMaterials(named.entries.map(({ material }) => material)),
          folderSearch: searchFolder ? true : undefined,
          steps: skill.custom
            ? [skill.custom.steps, skill.instruction].filter(Boolean).join("\n")
            : undefined,
          result: skill.custom?.result,
        },
        plan: capacity.plan,
        request: {
          instruction: t("draft.prompt", { instruction: prompt }),
          preferences: preferences.request,
          taskContext: capacity.plan.contexts[0],
          responseFormat: "draft",
        },
        folder: searchFolder,
        callLimit: showCallPlan ? callLimit.limit : undefined,
      },
      connection,
      toolPicker.plan,
    );
  }

  async function runDraft(task: DraftTask, connection: DraftConnection, tool?: WritingToolPlan) {
    if (controller.current) return;
    if (
      hasTaskImages(
        ...task.plan.contexts.map(
          (context, index) => task.replayRequests?.[index]?.taskContext ?? context,
        ),
      ) &&
      !checkVision(connection.visionTarget)?.verified
    ) {
      setError("materials.visionRequired");
      return;
    }
    const running = new AbortController();
    const { signal } = running;
    controller.current = running;
    toolPicker.clear();
    retryConnection.current = connection;
    const { id, label } = connection;
    const entry = { id: crypto.randomUUID(), task, connection: { id, label } };
    let partial = "";
    const dispatched: WritingRequest[] = [];
    let approved = (task.replayRequests ?? []).flatMap((request) =>
      (request?.taskContext?.materialDecisions ?? []).flatMap((decision) =>
        decision.outcome === "allowed" ? [decision.material] : [],
      ),
    );
    let sentContext = task.request.taskContext;
    const passages: SourcePassage[] = [];
    let nextOffset = 0;
    let readingSources = false;
    let status: AttemptStatus;
    let capacityRejected = false;
    let atCallLimit = false;
    function saveResult(
      text: string,
      status: AttemptStatus,
      direct: boolean,
      ignoredChanges?: boolean,
    ) {
      if (temporary) return;
      recordWritingResult(platform.writingTasks, store, {
        tabId,
        id: task.id,
        turn: {
          instruction: task.title,
          method: task.method,
          preferences: task.request.preferences,
          reply: text,
          context: sentContext,
          searchFolder: task.folder ?? undefined,
          recipient: connection.label,
          recipientId: connection.id,
          direct,
          ignoredChanges,
          toolOutcome: toolApproval.result(),
          sourcePassages: passages.length ? passages : undefined,
          status,
        },
        onError: () => {
          if (mounted.current) setSaveFailed(true);
        },
      });
    }
    setError(null);
    setRetryId("");
    setAttempt({ ...entry, approved, partial, status: "working" });
    try {
      const taskCopy = temporary && connection.agentAccess !== undefined;
      if (taskCopy && !temporaryCopies.current.has(task.id)) {
        await platform.writingTasks.createTemporary(task.id);
        temporaryCopies.current.add(task.id);
      }
      const reply = await materialRequests.send(
        (request, options) => {
          readingSources = hasSourceMaterials(request.taskContext);
          return connection.send(
            { ...request, sourcePassages: readingSources ? true : undefined },
            options,
          );
        },
        task.request,
        connection.label,
        task.folder,
        {
          signal,
          taskId: taskCopy ? task.id : undefined,
          plan: task.plan,
          replayRequests: task.replayRequests,
          onDispatch(request, batch) {
            dispatched[batch] = request;
          },
          callLimit: task.callLimit,
          tool,
          onContext(context) {
            sentContext = context;
          },
          onProgress(text) {
            if (signal.aborted) return;
            partial = readingSources ? draftText(text) : text;
            setAttempt({ ...entry, approved, partial, status: "working" });
          },
          mapBatchReply(reply, context) {
            if (reply.taskCopy === null) throw "invalidReply";
            if (replyStatus(reply) !== "complete")
              return readingSources ? { ...reply, text: draftText(reply.text) } : reply;
            const result = readDraftPassages(reply.text, dialect, context, reply.taskCopy);
            if (!result.text.trim()) throw "invalidReply";
            for (const passage of result.passages)
              passages.push({ ...passage, from: passage.from + nextOffset });
            nextOffset += result.text.length + 2; // The sender joins completed batches with a blank line.
            return { ...reply, text: result.text };
          },
          onApproval(text) {
            partial = text;
            setAttempt({ ...entry, approved, partial, status: "approval" });
          },
          onPause(text) {
            partial = text;
            atCallLimit = true;
            setAttempt({ ...entry, approved, partial, status: "paused" });
          },
          onResume(decision, text) {
            partial = text;
            atCallLimit = false;
            if (decision?.outcome === "allowed") approved = [...approved, decision.material];
            if (!signal.aborted) setAttempt({ ...entry, approved, partial, status: "working" });
          },
        },
      );
      if (!mounted.current) return;
      status = signal.aborted ? "stopped" : replyStatus(reply);
      partial = reply.text;
      if (status !== "complete" && reply.taskCopy?.trim()) {
        setUnapplied(reply.taskCopy);
        saveResult(reply.taskCopy, status, false, reply.ignoredChanges);
      }
      if (status === "complete") {
        controller.current = null;
        retryConnection.current = null;
        setKey("");
        const inserted = onDraft(reply.text);
        saveResult(reply.text, status, inserted, reply.ignoredChanges);
        if (inserted) {
          setApplied({ text: reply.text, passages, context: sentContext, connection });
          setAttempt({ ...entry, approved, status, partial: "" });
          if (store.getState().activeId === tabId) store.editor(tabId)?.focus();
          return;
        }
        setUnapplied(reply.text);
        setError("draft.changed");
        partial = "";
      }
    } catch (error) {
      if (!mounted.current) return;
      status = failureStatus(error, signal);
      capacityRejected = !signal.aborted && isMaterialCapacityError(error);
      if (capacityRejected) capacity.reject(connection.label);
      else if (status === "interrupted" && isLocalModelOffline(connection.endpoint, error)) {
        setError("writing.localOffline");
      } else if (status === "failed") {
        const code = error instanceof Error ? error.message : error;
        setError(
          code === "agentChanged" || code === "agentAccessRequired"
            ? "agent.reviewAgain"
            : code === "agentTaskCopyUnavailable"
              ? "agent.taskCopyUnavailable"
              : code === "connectionMissing"
                ? "draft.connectionUnavailable"
                : "draft.failed",
        );
      }
    }
    if (!mounted.current) return;
    const savedAtLimit = atCallLimit && (!!partial || !!toolApproval.result());
    if (savedAtLimit) saveResult(partial, status, false);
    if (partial) {
      const reply = { id: crypto.randomUUID(), text: partial, finished: atCallLimit };
      setPartials((previous) => [...previous, reply]);
    }
    setAttempt({
      ...entry,
      task: {
        ...task,
        replayRequests: dispatched.length
          ? task.plan.contexts.map((_, index) => dispatched[index] ?? task.replayRequests?.[index])
          : task.replayRequests,
      },
      approved,
      status,
      partial: "",
      capacityRejected,
      savedAtLimit,
    });
    controller.current = null;
  }

  const pause = materialRequests.paused;
  const pending = materialRequests.pending ?? toolApproval.pending;
  const report = useMemo(
    () =>
      attempt && {
        id: attempt.task.id,
        tabId,
        title: attempt.task.title,
        name,
        recipient: attempt.connection.label,
        material: [
          t("writing.scope.untitled"),
          ...writingMaterialNames(attempt.task.request),
          ...attempt.approved.map(({ name }) => name),
          ...(pending ? [pending.name] : []),
        ].join(" · "),
        status: attempt.status,
        count: 0,
        decisions: Number(!!pending || !!pause || !!unapplied),
        background: !active || collapsed,
        notice: pending
          ? { id: `${attempt.id}:approval:${pending.id}`, detail: pending.name, decisions: 1 }
          : pause
            ? { id: `${attempt.id}:call:${pause.calls}`, detail: pause.recipient, decisions: 1 }
            : attempt.status === "complete"
              ? { id: attempt.id, decisions: Number(!!unapplied) }
              : undefined,
        stop: busy ? () => controller.current?.abort() : undefined,
        forget: () => {
          if (temporary) {
            store.activate(tabId);
            setCollapsed(false);
            setConfirmClose(true);
            return;
          }
          setAttempt(null);
          setPartials([]);
          setUnapplied("");
          if (appliedReply) onClose(tabId);
        },
        reveal: () => {
          store.activate(tabId);
          setCollapsed(false);
          if (appliedReply) setShowAppliedReply(true);
        },
      },
    [
      active,
      appliedReply,
      attempt,
      busy,
      collapsed,
      name,
      onClose,
      pause,
      pending,
      store,
      t,
      tabId,
      unapplied,
      temporary,
    ],
  );
  useWritingTask(report);

  function close() {
    if (temporary && attempt) setConfirmClose(true);
    else if (!attempt || (!busy && attempt.status === "complete")) onClose(tabId);
    else {
      setCollapsed(true);
      if (active) store.editor(tabId)?.focus();
    }
  }

  function resolveClose(confirmed: boolean) {
    const finish = closeGuard.current;
    closeGuard.current = null;
    setConfirmClose(false);
    if (confirmed) {
      onClose(tabId);
      if (!finish) requestAnimationFrame(() => store.editor(tabId)?.focus());
    }
    finish?.(confirmed);
  }

  async function closeTemporary() {
    if (controller.current || closing) return;
    setClosing(true);
    setCleanupFailed(false);
    try {
      for (const id of temporaryCopies.current) {
        await platform.writingTasks.removeTemporary(id);
        temporaryCopies.current.delete(id);
      }
      resolveClose(true);
    } catch {
      setCleanupFailed(true);
    } finally {
      setClosing(false);
    }
  }

  const closeDialog = confirmClose && (
    <TemporarySessionClose
      busy={busy}
      closing={closing}
      failed={cleanupFailed}
      onCancel={() => resolveClose(false)}
      onReview={
        applied
          ? () => {
              resolveClose(false);
              setShowAppliedReply(true);
            }
          : undefined
      }
      onConfirm={() => void closeTemporary()}
    />
  );
  const retry =
    attempt && !busy && !attempt.capacityRejected && retryConnection.current
      ? { ...attempt, connection: retryConnection.current }
      : null;
  const alternatives = retry ? connections.filter(({ id }) => id !== retry.connection.id) : [];
  const alternate = alternatives.find(({ id }) => id === retryId);
  const retryPlan = retry && {
    ...retry.task.plan,
    contexts: retry.task.plan.contexts.map(
      (context, index) => retry.task.replayRequests?.[index]?.taskContext ?? context,
    ),
  };
  const retryHasImages = hasTaskImages(...(retryPlan?.contexts ?? []));
  const alternateVision = checkVision(alternate?.visionTarget);
  function retryDraft(connection: DraftConnection) {
    if (!retry) return;
    const task = retry.savedAtLimit ? { ...retry.task, id: crypto.randomUUID() } : retry.task;
    void runDraft(task, connection);
  }

  if (applied)
    return (
      <>
        {closeDialog}
        {temporary && (
          <div className="flex flex-wrap items-center gap-2 border-b border-(--mint-border) px-4 py-2 text-sm">
            <button type="button" className={button} onClick={close}>
              {t("writing.temporary.close")}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                const editor = store.editor(tabId);
                if (!editor) return;
                const live = editor.getText();
                const range = mapReviewRanges(applied.text, live).range({
                  from: 0,
                  to: applied.text.length,
                  located: true,
                });
                if (!range.located || live.slice(range.from, range.to) !== applied.text) {
                  setRevertConflict(true);
                  setShowAppliedReply(true);
                  return;
                }
                editor.replaceRanges([{ ...range, text: "" }], { lineEndings: "preserve" });
                setRevertConflict(false);
                setApplied(null);
                setShowAppliedReply(false);
              }}
            >
              {t("writing.edit.revertAll")}
            </button>
            {revertConflict && <p role="alert">{t("writing.edit.revertConflict")}</p>}
          </div>
        )}
        {applied.passages.length > 0 && (
          <div className="max-h-[45%] shrink-0 overflow-auto border-b border-(--mint-border) px-4 py-2">
            <SourcePassageReview
              draft={applied.text}
              passages={applied.passages}
              editor={store.editor(tabId)}
              context={applied.context}
              platform={platform}
              recipients={
                applied.connection.id
                  ? connections
                  : [{ ...applied.connection, id: "one-time-model" }, ...connections]
              }
              originalRecipient={applied.connection.id || "one-time-model"}
            />
          </div>
        )}
        {showAppliedReply && (
          <section
            aria-label={t("command.file.draftWithAi")}
            className="max-h-[70%] shrink-0 space-y-2 overflow-auto border-b border-(--mint-border) px-4 py-3 text-sm"
          >
            <header className="flex items-center justify-between gap-2">
              <h2 className="font-medium">{attempt?.task.title}</h2>
              <button
                type="button"
                className={button}
                onClick={() => {
                  setShowAppliedReply(false);
                  store.editor(tabId)?.focus();
                }}
              >
                {t("settings.close")}
              </button>
            </header>
            <textarea
              aria-label={t("writing.reply")}
              className="block w-full resize-y rounded bg-(--mint-hover) p-2 font-mono focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
              readOnly
              rows={3}
              value={appliedReply}
            />
          </section>
        )}
        {attempt?.task.request.preferences && (
          <details className="px-4 py-2 text-xs">
            <summary>{t("writing.preference.used")}</summary>
            <AppliedWritingPreferences preferences={attempt.task.request.preferences} />
          </details>
        )}
        <WritingToolOutcome outcome={toolApproval.outcome} />
        {(attempt?.task.plan.contexts.some(Boolean) ||
          (materialRequests.usage?.reportedCalls ?? 0) > 1) && (
          <WritingReportedUsage usage={materialRequests.usage} />
        )}
        {saveFailed && <p role="alert">{t("writing.tasks.saveFailed")}</p>}
      </>
    );
  if (collapsed)
    return (
      active && (
        <button
          type="button"
          className={`${button} self-start`}
          onClick={() => setCollapsed(false)}
        >
          {t("writing.resume")}
        </button>
      )
    );

  return (
    <form
      aria-labelledby={id}
      onSubmit={submit}
      onPaste={busy ? undefined : materialDropHandlers(named).onPaste}
      className="max-h-[70%] shrink-0 space-y-2 overflow-auto border-b border-(--mint-border) px-4 py-3 text-sm"
    >
      {closeDialog}
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="font-medium">
          {t("command.file.draftWithAi")}
        </h2>
        <button type="button" className={button} onClick={close}>
          {t(temporary && attempt ? "writing.temporary.close" : "settings.close")}
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={temporary}
          disabled={!!attempt}
          onChange={(event) => setTemporary(event.target.checked)}
        />
        {t("writing.temporary.label")}
      </label>
      <fieldset
        hidden={!!pending || !!materialRequests.paused}
        disabled={busy || !!unapplied}
        className="space-y-2"
      >
        <label className="block">
          {t("draft.instruction")}
          <input
            ref={input}
            className={field}
            value={instruction}
            onChange={(event) => chooseSkill(event.target.value)}
            placeholder={draftSkills.length ? t("writing.skill.placeholder") : undefined}
          />
        </label>
        {!!skill.suggestions?.length && (
          <WritingSkillChoices
            platform={platform}
            skills={draftSkills}
            suggestions={skill.suggestions}
            onChoose={(id) => {
              chooseSkill(`/${id} `);
              input.current?.focus();
            }}
            showImport={false}
          />
        )}
        {skill.custom && (
          <fieldset className="min-w-0 space-y-1 rounded border border-(--mint-border) p-2">
            <legend>{t("writing.skill.plan")}</legend>
            <WritingSkillDetails draft={skill.custom} />
            <ExportWritingSkillButton platform={platform} skill={skill.custom} />
          </fieldset>
        )}
        {(!!recipients?.length || unavailable) && (
          <label className="block">
            {t("draft.connection")}
            <select
              className={field}
              value={selected}
              onChange={(event) => {
                setChoice(event.target.value);
                setKey("");
                setAllowedFolder(null);
                toolPicker.clear();
              }}
            >
              <option value="">{t("models.custom")}</option>
              {unavailable && (
                <option value={selected} disabled>
                  {t("draft.connectionUnavailable")}
                </option>
              )}
              {recipients?.map((candidate) => (
                <option key={candidate.id} value={writingConnectionId(candidate)}>
                  {candidate.kind === "agent" ? candidate.path : candidate.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {custom && (
          <div className="grid gap-2 lg:grid-cols-3">
            <label>
              {t("models.address")}
              <input
                type="url"
                autoComplete="off"
                spellCheck={false}
                className={field}
                value={address}
                onChange={(event) => {
                  setChoice("");
                  setAddress(event.target.value);
                  setKey("");
                  setAllowedFolder(null);
                  toolPicker.clear();
                }}
              />
            </label>
            <label>
              {t("models.model")}
              <input
                className={field}
                spellCheck={false}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label>
              {t("draft.key")}
              <input
                type="password"
                autoComplete="off"
                className={field}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
          </div>
        )}
        {custom && address && !endpoint && (
          <p className="text-xs text-(--mint-muted)">{t("models.error.address")}</p>
        )}
        <p className="text-xs text-(--mint-muted)">{t("draft.scope")}</p>
        <TaskContextChecklist
          platform={platform}
          named={named}
          emptyDraft
          recipient={recipient}
          vision={vision}
          handlingFull={capacity.method === "full"}
          folder={folder}
          searchEnabled={!!searchFolder}
          onSearchChange={(checked) => setAllowedFolder(checked ? folder : null)}
        />
        {capacity.controls}
        <WritingPreferences preferences={preferences} correction={instruction} />
        <WritingToolPicker picker={toolPicker} />
        {recipient && capacity.plan && showCallPlan && (
          <WritingCallPlan
            recipient={recipient}
            requests={capacity.plan.contexts.map((taskContext) => ({ taskContext }))}
            limit={callLimit}
            toolEndpoint={toolPicker.plan?.endpoint}
          />
        )}
        {agent && (
          <details className="space-y-1 text-xs text-(--mint-muted)">
            <summary>{t(`agent.${agent.access}`)}</summary>
            <ExternalAgentAccessNotice access={agent.access} />
          </details>
        )}
        <button type="submit" disabled={!canSend} className={button}>
          {toolPicker.plan?.exact
            ? t("mcp.send", {
                send: t("draft.generate"),
                effect: t(`mcp.effect.${toolPicker.plan.effect}`),
              })
            : t("draft.generate")}
        </button>
      </fieldset>
      {pause && <WritingCallPause pause={pause} usage={materialRequests.usage} />}
      {toolApproval.pending && (
        <WritingToolNotice pending={toolApproval.pending} onDecision={toolApproval.decide} />
      )}
      <WritingToolOutcome outcome={toolApproval.outcome} />
      {materialRequests.pending ? (
        <MaterialRequestNotice
          key={materialRequests.pending.id}
          pending={materialRequests.pending}
          platform={platform}
          vision={checkVision(retryConnection.current?.visionTarget)}
          onDecision={materialRequests.decide}
        />
      ) : (
        busy && !pending && !materialRequests.paused && <p role="status">{t("draft.generating")}</p>
      )}
      {attempt && (
        <WritingTaskMaterials
          request={attempt.task.request}
          approved={attempt.approved}
          folder={attempt.task.folder}
        />
      )}
      {busy && (
        <button type="button" className={button} onClick={() => controller.current?.abort()}>
          {t("writing.task.stop")}
        </button>
      )}
      {retry && (
        <div className="space-y-2">
          <p role="status">{t(`writing.task.${retry.status}`)}</p>
          <button type="button" className={button} onClick={() => retryDraft(retry.connection)}>
            {t("writing.task.retry")}
          </button>
          <WritingRetryEstimate usage={materialRequests.usage} />
          {alternatives.length > 0 && (
            <>
              <label>
                {t("writing.task.retryConnection")}
                <select
                  className={field}
                  value={retryId}
                  onChange={(event) => setRetryId(event.target.value)}
                >
                  <option value="">{t("writing.chooseRecipient")}</option>
                  {alternatives.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {alternate && retryPlan && (
                <MaterialPlanPreview plan={retryPlan} recipient={alternate.label} />
              )}
              {retryHasImages && alternateVision && <VisionControl check={alternateVision} />}
              {retryHasImages && alternate && !alternateVision && (
                <p role="alert">{t("materials.visionRequired")}</p>
              )}
              <button
                type="button"
                className={button}
                disabled={!alternate || (retryHasImages && !alternateVision?.verified)}
                onClick={() => alternate && retryDraft(alternate)}
              >
                {t("writing.task.retryOther")}
              </button>
            </>
          )}
        </div>
      )}
      {[true, false].map((finished) => {
        const results = partials.filter((reply) => !!reply.finished === finished);
        const progress = !finished && !pause ? attempt?.partial : undefined;
        if (!results.length && !progress) return null;
        return (
          <section
            key={String(finished)}
            aria-label={t(finished ? "writing.calls.retained" : "writing.task.partial")}
            className="space-y-2"
          >
            {results.map(({ id, text }) => (
              <pre key={id} className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">
                {text}
              </pre>
            ))}
            {progress && (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">
                {progress}
              </pre>
            )}
          </section>
        );
      })}
      {error && <p role="alert">{t(error)}</p>}
      {saveFailed && <p role="alert">{t("writing.tasks.saveFailed")}</p>}
      {unapplied && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">{unapplied}</pre>
      )}
    </form>
  );
}
