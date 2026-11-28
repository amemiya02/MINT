import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { useSettings } from "../settings/useSettings.ts";
import { useTabStore } from "../tabs/context.ts";
import { ExternalAgentAccessNotice } from "./ExternalAgentPanel.tsx";
import { type AgentAccess, type ExternalAgent, externalAgentSender } from "./external-agent.ts";
import {
  type MaterialPlan,
  MaterialPlanPreview,
  useMaterialCapacity,
} from "./MaterialCapacity.tsx";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { useModelVision, VisionControl, type VisionTarget } from "./ModelVision.tsx";
import { modelEndpoint, modelWritingSender, type SavedModelConnection } from "./model.ts";
import { recordWritingResult } from "./record-writing-result.ts";
import { SourcePassageReview } from "./SourcePassageReview.tsx";
import {
  draftText,
  hasSourceMaterials,
  readDraftPassages,
  type SourcePassage,
} from "./source-passages.ts";
import { materialDropHandlers, TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
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
  writingMaterialNames,
} from "./writing-attempt.ts";
import {
  hasTaskImages,
  type NamedMaterial,
  type TaskContext,
  type WritingRequest,
  type WritingSender,
} from "./writing-sender.ts";

const field =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const button =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

interface DraftConnection {
  readonly id: string;
  readonly label: string;
  readonly send: WritingSender;
  readonly visionTarget?: VisionTarget;
  readonly agentAccess?: AgentAccess;
}

interface DraftTask {
  readonly id: string;
  readonly title: string;
  readonly request: WritingRequest;
  readonly plan: MaterialPlan;
  readonly folder: string | null;
}

interface DraftAttempt {
  readonly id: string;
  readonly task: DraftTask;
  readonly connection: Omit<DraftConnection, "send">;
  readonly status: AttemptStatus;
  readonly partial: string;
  readonly approved: readonly NamedMaterial[];
  readonly capacityRejected?: boolean;
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
  const [collapsed, setCollapsed] = useState(false);
  const [attempt, setAttempt] = useState<DraftAttempt | null>(null);
  const [partials, setPartials] = useState<readonly { id: string; text: string }[]>([]);
  const [retryId, setRetryId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [models, setModels] = useState<readonly SavedModelConnection[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const { settings } = useSettings();
  const busy = attempt?.status === "working" || attempt?.status === "approval";
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
  const [allowedFolder, setAllowedFolder] = useState<string | null>(null);
  const searchFolder = allowedFolder === folder ? folder : null;
  const materialRequests = useMaterialRequests(platform.sendMcpRequest);
  const toolPicker = useWritingToolPicker(platform.sendMcpRequest);
  const toolApproval = materialRequests.externalTool;
  const defaultConnection = settings.defaultWritingConnection;
  const selected =
    choice ??
    (defaultConnection ||
      (models[0] ? `model:${models[0].id}` : agents[0] ? `agent:${agents[0].path}` : ""));
  const agent = agents.find(({ path }) => `agent:${path}` === selected);
  const remembered = models.find(({ id }) => `model:${id}` === selected);
  const custom = !selected;
  const unavailable = !custom && !agent && !remembered;
  let endpoint = "";
  try {
    endpoint = modelEndpoint(remembered?.address ?? address);
  } catch {
    // Sending stays unavailable until the endpoint is valid.
  }
  const recipient = agent
    ? t("writing.recipient.agent", { path: agent.path })
    : !unavailable && endpoint
      ? remembered
        ? t("writing.recipient.model", { name: remembered.name, endpoint })
        : endpoint
      : undefined;

  const capacity = useMaterialCapacity({
    recipient,
    entries: named.entries,
    folderSearch: !!searchFolder,
  });

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

  useEffect(() => {
    if (!appliedReply) return;
    const editor = store.editor(tabId);
    return editor?.subscribe(({ type }) => {
      if (type !== "change") return;
      const tab = store.getState().tabs.find(({ id }) => id === tabId);
      if (tab?.path === null && editor.getText() === "") onClose(tabId);
    });
  }, [appliedReply, onClose, store, tabId]);

  useEffect(() => {
    if (settingsOpen) return;
    let mounted = true;
    void platform.listModelConnections().then(
      (saved) => {
        if (!mounted) return;
        setModels(saved);
      },
      () => {
        if (mounted) setError("models.error.connections");
      },
    );
    void platform.externalAgent.saved().then(
      (saved) => {
        if (mounted) {
          setAgents(saved.filter((agent) => agent.approved.includes(agent.preferredAccess)));
        }
      },
      () => {
        if (mounted) setError("agent.loadFailed");
      },
    );
    return () => {
      mounted = false;
    };
  }, [platform, settingsOpen]);

  const checkVision = useModelVision(platform.sendModelMessage);
  const inlineTarget: VisionTarget = useMemo(
    () => ({ id: crypto.randomUUID(), connection: { address, model }, apiKey: key }),
    [address, model, key],
  );
  const vision = checkVision(
    remembered
      ? { id: `model:${remembered.id}`, connection: { id: remembered.id } }
      : custom && endpoint && model.trim()
        ? inlineTarget
        : undefined,
  );
  const canSend =
    !!instruction.trim() &&
    !toolPicker.incomplete &&
    !named.loading &&
    !named.unconfirmed &&
    (!named.hasImages || vision?.verified === true) &&
    !!capacity.plan &&
    (!!agent || (!!endpoint && (!!remembered || (custom && !!model.trim()))));

  const connections: DraftConnection[] = [
    ...models.map((item) => ({
      id: `model:${item.id}`,
      label: t("writing.recipient.model", {
        name: item.name,
        endpoint: modelEndpoint(item.address),
      }),
      send: modelWritingSender(platform.sendModelMessage, item),
      visionTarget: { id: `model:${item.id}`, connection: { id: item.id } },
    })),
    ...agents.map((item) => ({
      id: `agent:${item.path}`,
      label: t("writing.recipient.agent", { path: item.path }),
      send: externalAgentSender(platform.externalAgent, item, item.preferredAccess),
      agentAccess: item.preferredAccess,
    })),
  ];

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
          send: modelWritingSender(platform.sendModelMessage, inlineTarget.connection, {
            apiKey: key,
          }),
          visionTarget: inlineTarget,
        }
      : connections.find(({ id }) => id === selected);
    if (!connection) return;
    await runDraft(
      {
        id: crypto.randomUUID(),
        title: instruction.trim(),
        plan: capacity.plan,
        request: {
          instruction: t("draft.prompt", { instruction: instruction.trim() }),
          taskContext: capacity.plan.contexts[0],
          responseFormat: "draft",
        },
        folder: searchFolder,
      },
      connection,
      toolPicker.plan,
    );
  }

  async function runDraft(task: DraftTask, connection: DraftConnection, tool?: WritingToolPlan) {
    if (controller.current) return;
    if (hasTaskImages(...task.plan.contexts) && !checkVision(connection.visionTarget)?.verified) {
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
    let approved: NamedMaterial[] = [];
    let sentContext = task.request.taskContext;
    const passages: SourcePassage[] = [];
    let nextOffset = 0;
    let readingSources = false;
    let status: AttemptStatus;
    let capacityRejected = false;
    setError(null);
    setRetryId("");
    setAttempt({ ...entry, approved, partial, status: "working" });
    try {
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
          plan: task.plan,
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
            const result = readDraftPassages(reply.text, context, reply.taskCopy);
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
          onResume(decision, text) {
            partial = text;
            if (decision?.outcome === "allowed") approved = [...approved, decision.material];
            if (!signal.aborted) setAttempt({ ...entry, approved, partial, status: "working" });
          },
        },
      );
      if (!mounted.current) return;
      status = signal.aborted ? "stopped" : replyStatus(reply);
      partial = reply.text;
      if (status === "complete") {
        controller.current = null;
        retryConnection.current = null;
        setKey("");
        const inserted = onDraft(reply.text);
        recordWritingResult(platform.writingTasks, store, {
          tabId,
          id: task.id,
          turn: {
            instruction: task.title,
            reply: reply.text,
            context: sentContext,
            searchFolder: task.folder ?? undefined,
            recipient: connection.label,
            recipientId: connection.id,
            direct: inserted,
            ignoredChanges: reply.ignoredChanges,
            toolOutcome: toolApproval.result(),
            sourcePassages: passages.length ? passages : undefined,
            status,
          },
          onError: () => {
            if (mounted.current) setSaveFailed(true);
          },
        });
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
      else if (status === "failed") {
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
    if (partial) {
      const reply = { id: crypto.randomUUID(), text: partial };
      setPartials((previous) => [...previous, reply]);
    }
    setAttempt({ ...entry, approved, status, partial: "", capacityRejected });
    controller.current = null;
  }

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
        decisions: Number(!!pending || !!unapplied),
        background: !active || collapsed,
        notice: pending
          ? { id: `${attempt.id}:approval:${pending.id}`, detail: pending.name, decisions: 1 }
          : attempt.status === "complete"
            ? { id: attempt.id, decisions: Number(!!unapplied) }
            : undefined,
        stop: busy ? () => controller.current?.abort() : undefined,
        forget: () => {
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
      pending,
      store,
      t,
      tabId,
      unapplied,
    ],
  );
  useWritingTask(report);

  function close() {
    if (!attempt || (!busy && attempt.status === "complete")) onClose(tabId);
    else {
      setCollapsed(true);
      if (active) store.editor(tabId)?.focus();
    }
  }

  const retry =
    attempt && !busy && !attempt.capacityRejected && retryConnection.current
      ? { ...attempt, connection: retryConnection.current }
      : null;
  const alternatives = retry ? connections.filter(({ id }) => id !== retry.connection.id) : [];
  const alternate = alternatives.find(({ id }) => id === retryId);
  const retryHasImages = hasTaskImages(...(retry?.task.plan.contexts ?? []));
  const alternateVision = checkVision(alternate?.visionTarget);

  if (applied)
    return (
      <>
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
        <WritingToolOutcome outcome={toolApproval.outcome} />
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
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="font-medium">
          {t("command.file.draftWithAi")}
        </h2>
        <button type="button" className={button} onClick={close}>
          {t("settings.close")}
        </button>
      </div>
      <fieldset hidden={!!pending} disabled={busy || !!unapplied} className="space-y-2">
        <label className="block">
          {t("draft.instruction")}
          <input
            ref={input}
            className={field}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        {(models.length > 0 || agents.length > 0 || unavailable) && (
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
              {models.map(({ id, name }) => (
                <option key={id} value={`model:${id}`}>
                  {name}
                </option>
              ))}
              {agents.map(({ path }) => (
                <option key={path} value={`agent:${path}`}>
                  {path}
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
        <WritingToolPicker picker={toolPicker} />
        {agent && (
          <details className="space-y-1 text-xs text-(--mint-muted)">
            <summary>{t(`agent.${agent.preferredAccess}`)}</summary>
            <ExternalAgentAccessNotice access={agent.preferredAccess} />
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
        busy && !pending && <p role="status">{t("draft.generating")}</p>
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
          <button
            type="button"
            className={button}
            onClick={() => void runDraft(retry.task, retry.connection)}
          >
            {t("writing.task.retry")}
          </button>
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
              {alternate && (
                <MaterialPlanPreview plan={retry.task.plan} recipient={alternate.label} />
              )}
              {retryHasImages && alternateVision && <VisionControl check={alternateVision} />}
              {retryHasImages && alternate && !alternateVision && (
                <p role="alert">{t("materials.visionRequired")}</p>
              )}
              <button
                type="button"
                className={button}
                disabled={!alternate || (retryHasImages && !alternateVision?.verified)}
                onClick={() => alternate && void runDraft(retry.task, alternate)}
              >
                {t("writing.task.retryOther")}
              </button>
            </>
          )}
        </div>
      )}
      {(partials.length > 0 || attempt?.partial) && (
        <section aria-label={t("writing.task.partial")} className="space-y-2">
          {partials.map(({ id, text }) => (
            <pre key={id} className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">
              {text}
            </pre>
          ))}
          {attempt?.partial && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">
              {attempt.partial}
            </pre>
          )}
        </section>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {saveFailed && <p role="alert">{t("writing.tasks.saveFailed")}</p>}
      {unapplied && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">{unapplied}</pre>
      )}
    </form>
  );
}
