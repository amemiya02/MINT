import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { ConnectionSection } from "./ConnectionSection.tsx";
import {
  type AgentAccess,
  type ExternalAgent,
  type ExternalAgentPlatform,
  externalAgentSender,
} from "./external-agent.ts";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";
import {
  largeWritingSelection,
  useWritingCallLimit,
  WritingCallPause,
  WritingCallPlan,
} from "./WritingCallLimit.tsx";
import {
  AppliedWritingPreferences,
  useWritingPreferences,
  WritingPreferences,
} from "./WritingPreferences.tsx";
import { useWritingTask } from "./WritingTasks.tsx";
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
  replyStatus,
  writingMaterialNames,
} from "./writing-attempt.ts";
import type { WritingRequest } from "./writing-sender.ts";
import type { SavedTurn } from "./writing-tasks.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

export function ExternalAgentAccessNotice({ access }: { readonly access: AgentAccess }) {
  const t = useT();
  return (
    <>
      <p>
        {t("agent.processAccess")} {t(`agent.${access}Access`)}
      </p>
      <p>{t(access === "taskCopy" ? "agent.taskCopyTools" : "agent.tools")}</p>
      <p>{t(access === "taskCopy" ? "agent.taskCopyLogin" : "agent.usesLogin")}</p>
      <p>{t("agent.retention")}</p>
    </>
  );
}

export function ExternalAgentSettings({
  platform,
  onConnectionsChanged,
}: {
  readonly platform: ExternalAgentPlatform;
  readonly onConnectionsChanged: (agents: ExternalAgent[]) => void;
}) {
  const t = useT();
  return (
    <ConnectionSection title={t("agent.title")} preserveContent>
      <div className="px-3 pb-3">
        <ExternalAgentPanel platform={platform} onConnectionsChanged={onConnectionsChanged} />
      </div>
    </ConnectionSection>
  );
}

interface AgentTaskTarget {
  readonly tabId: number;
  readonly name: string;
  readonly visible: boolean;
  readonly reveal: () => void;
  readonly record: (id: string, turn: SavedTurn) => void;
  readonly engaged: { current: boolean };
}

export function ExternalAgentDialog({
  platform,
  selection,
  onClose,
  onHide,
  onReveal,
  onResult,
  name,
  folder,
  tabId,
  visible,
  renderReply,
}: {
  readonly platform: Platform;
  readonly selection: string;
  readonly onClose: () => void;
  readonly onHide: () => void;
  readonly onReveal: () => void;
  readonly onResult: (id: string, turn: SavedTurn) => void;
  readonly name: string;
  readonly folder: string | null;
  readonly tabId: number;
  readonly visible: boolean;
  readonly renderReply: (reply: string, close: () => void) => ReactNode;
}) {
  const t = useT();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const engaged = useRef(false);
  const reveal = useRef(onReveal);
  const result = useRef(onResult);
  reveal.current = onReveal;
  result.current = onResult;
  const target = useMemo(
    () => ({
      tabId,
      name,
      visible,
      engaged,
      reveal: () => reveal.current(),
      record: (id: string, turn: SavedTurn) => result.current(id, turn),
    }),
    [name, tabId, visible],
  );
  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
  }, [visible]);

  function close() {
    dialog.current?.close();
    if (engaged.current) onHide();
    else onClose();
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-labelledby={title}
      className="m-auto max-h-[85vh] w-[min(32rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={title}>{t("agent.askTitle")}</h2>
        <button type="button" className={buttonClass} onClick={close}>
          {t("settings.close")}
        </button>
      </div>
      <ExternalAgentPanel
        platform={platform.externalAgent}
        materialsPlatform={platform}
        folder={folder}
        selection={selection}
        target={target}
        renderReply={(reply) =>
          renderReply(reply, () => {
            dialog.current?.close();
            onClose();
          })
        }
      />
    </dialog>
  );
}

function ExternalAgentPanel({
  platform,
  onConnectionsChanged,
  materialsPlatform,
  folder = null,
  selection,
  renderReply,
  target,
}: {
  readonly platform: ExternalAgentPlatform;
  readonly onConnectionsChanged?: (agents: ExternalAgent[]) => void;
  readonly selection?: string;
  readonly materialsPlatform?: Platform;
  readonly folder?: string | null;
  readonly renderReply?: (reply: string) => ReactNode;
  readonly target?: AgentTaskTarget;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<ExternalAgent | null>(null);
  const [access, setAccess] = useState<AgentAccess>("readOnly");
  const [saved, setSaved] = useState<ExternalAgent[]>([]);
  const [found, setFound] = useState<string[] | null>(null);
  const [instruction, setInstruction] = useState("");
  const preferences = useWritingPreferences(materialsPlatform, folder);
  const named = useNamedMaterials();
  const materialRequests = useMaterialRequests(materialsPlatform?.sendMcpRequest);
  const callLimit = useWritingCallLimit();
  const requested = materialRequests.pending;
  const [pending, setPending] = useState<{
    id: string;
    request: WritingRequest;
    tool?: WritingToolPlan;
    callLimit?: number;
  } | null>(null);
  const picker = useWritingToolPicker(materialsPlatform?.sendMcpRequest);
  const toolApproval = materialRequests.externalTool;
  const toolPending = toolApproval.pending;
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState("");
  const [partial, setPartial] = useState<readonly { id: string; text: string }[]>([]);
  const [attempt, setAttempt] = useState<{
    id: string;
    title: string;
    recipient: string;
    status: AttemptStatus;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastRequest = useRef<{
    agent: ExternalAgent;
    access: AgentAccess;
    request: WritingRequest;
    callLimit?: number;
  } | null>(null);
  const mounted = useRef(true);
  const pause = materialRequests.paused;
  const taskStatus = pause
    ? "paused"
    : pending || requested || toolPending
      ? "approval"
      : attempt?.status;
  if (target) target.engaged.current = !!taskStatus && taskStatus !== "complete";
  const taskRecipient = pending ? agent?.path : attempt?.recipient;
  const taskRequest = pending?.request ?? lastRequest.current?.request;
  const taskMaterial = [
    t("writing.scope.selection"),
    ...(taskRequest ? writingMaterialNames(taskRequest) : []),
    ...(requested ? [requested.name] : []),
    ...(toolPending ? [toolPending.name] : []),
  ].join(" · ");
  const stop = useCallback(() => {
    if (controller.current) controller.current.abort();
    else if (taskRecipient) {
      setPending(null);
      setAttempt({
        id: pending?.id ?? crypto.randomUUID(),
        title: pending?.request.instruction ?? instruction,
        recipient: taskRecipient,
        status: "stopped",
      });
    }
  }, [instruction, pending, taskRecipient]);
  const task = useMemo(
    () =>
      target && taskStatus && taskRecipient
        ? {
            id: pending?.id ?? attempt?.id,
            tabId: target.tabId,
            title: pending?.request.instruction ?? attempt?.title ?? instruction,
            name: target.name,
            recipient: t("writing.recipient.agent", { path: taskRecipient }),
            material: taskMaterial,
            status: taskStatus,
            count: 0,
            decisions: Number(!!(pending || requested || toolPending || pause)),
            background: !target.visible,
            notice: pending
              ? { id: pending.id, decisions: 1 }
              : requested && attempt
                ? { id: `${attempt.id}:${requested.id}`, detail: requested.name, decisions: 1 }
                : toolPending
                  ? { id: toolPending.id, detail: toolPending.name, decisions: 1 }
                  : pause && attempt
                    ? {
                        id: `${attempt.id}:call:${pause.calls}`,
                        detail: pause.recipient,
                        decisions: 1,
                      }
                    : attempt?.status === "complete"
                      ? { id: attempt.id }
                      : undefined,
            stop:
              taskStatus === "working" || taskStatus === "approval" || taskStatus === "paused"
                ? stop
                : undefined,
            forget: () => {
              setAttempt(null);
              setReply("");
            },
            reveal: target.reveal,
          }
        : null,
    [
      attempt,
      instruction,
      pause,
      pending,
      requested,
      stop,
      t,
      target,
      taskMaterial,
      taskRecipient,
      taskStatus,
      toolPending,
    ],
  );
  useWritingTask(task);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const declineButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const sampleInstruction = t("agent.sampleInstruction");
  const material = selection ?? t("agent.sampleText");
  const selectedContext: WritingRequest["taskContext"] = named.entries.length
    ? { materials: named.entries.map(({ material }) => material) }
    : undefined;
  const showCallPlan =
    !!materialsPlatform &&
    (!!selectedContext || !!picker.plan || material.length >= largeWritingSelection);

  const select = useCallback(
    (next: ExternalAgent | null, requestedAccess = next?.preferredAccess) => {
      setAgent(next);
      setAccess(requestedAccess ?? "readOnly");
      setReply("");
    },
    [],
  );

  useEffect(() => {
    let closed = false;
    void platform.saved().then(
      (agents) => {
        if (closed) return;
        setSaved(agents);
        select(agents[0] ?? null);
        setBusy(false);
      },
      () => {
        if (closed) return;
        setError("agent.loadFailed");
        setBusy(false);
      },
    );
    return () => {
      closed = true;
    };
  }, [platform, select]);

  useEffect(() => {
    if (pending) declineButton.current?.focus();
    else if (status === "agent.declined") sendButton.current?.focus();
  }, [pending, status]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await operation();
    } catch (problem) {
      const code = problem instanceof Error ? problem.message : problem;
      if (code === "agentChanged" || code === "agentAccessRequired") {
        if (agent) select(await platform.inspect(agent.path).catch(() => null), access);
        setError("agent.reviewAgain");
      } else {
        setError(
          code === "agentTaskCopyUnavailable"
            ? "agent.taskCopyUnavailable"
            : code === "agentUnavailable"
              ? "agent.unavailable"
              : "agent.failed",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function inspect(candidate: string) {
    picker.clear();
    void run(async () => {
      select(await platform.inspect(candidate.trim()));
    });
  }

  function retainPartial(text: string) {
    if (!text) return;
    const reply = { id: crypto.randomUUID(), text };
    setPartial((previous) => [...previous, reply]);
  }

  function send(
    current: ExternalAgent,
    request: WritingRequest,
    approve: boolean,
    tool?: WritingToolPlan,
    limit?: number,
  ) {
    if (controller.current) return;
    setPending(null);
    setReply("");
    setStreaming("");
    picker.clear();
    lastRequest.current = { agent: current, access, request, callLimit: limit };
    const running = target ? new AbortController() : null;
    const signal = running?.signal;
    const entry = { id: crypto.randomUUID(), title: request.instruction, recipient: current.path };
    controller.current = running;
    if (running) setAttempt({ ...entry, status: "working" });
    void run(async () => {
      let text = "";
      let context = request.taskContext;
      let atCallLimit = false;
      const recipient = t("writing.recipient.agent", { path: current.path });
      function record(reply: string, status: AttemptStatus) {
        target?.record(entry.id, {
          instruction: request.instruction,
          preferences: request.preferences,
          material: request.selectedText,
          context,
          reply,
          recipient,
          toolOutcome: toolApproval.result(),
          recipientId: `agent:${current.path}`,
          direct: false,
          status,
        });
      }
      try {
        const connection = approve ? await platform.approve(current, access) : current;
        if (!mounted.current) return;
        if (approve) {
          setAgent(connection);
          const connections = [
            connection,
            ...saved.filter((item) => item.path !== connection.path),
          ];
          setSaved(connections);
          onConnectionsChanged?.(connections);
        }
        if (signal?.aborted) throw "stopped";
        const sender = externalAgentSender(platform, connection, access);
        const result = materialsPlatform
          ? await materialRequests.send(sender, request, recipient, null, {
              signal,
              tool,
              callLimit: limit,
              onContext(sent) {
                context = sent;
              },
              onProgress(progress) {
                if (signal?.aborted) return;
                text = progress;
                setStreaming(text);
              },
              onPause(completed) {
                text = completed;
                atCallLimit = true;
                setStreaming("");
              },
              onResume() {
                atCallLimit = false;
              },
            })
          : await sender(request);
        if (!mounted.current) return;
        const outcome = signal?.aborted ? "stopped" : replyStatus(result);
        if (running) setAttempt({ ...entry, status: outcome });
        if (outcome !== "complete") {
          retainPartial(result.text);
          return;
        }
        const verified = {
          ...connection,
          preferredAccess: access,
          verified:
            access !== "taskCopy" ||
            (result.taskCopy != null && result.taskCopy !== request.selectedText)
              ? [...new Set([...connection.verified, access])]
              : connection.verified,
        };
        setAgent(verified);
        const connections = [verified, ...saved.filter((item) => item.path !== verified.path)];
        setSaved(connections);
        onConnectionsChanged?.(connections);
        setReply(result.taskCopy ?? result.text);
        record(result.text, outcome);
      } catch (problem) {
        if (!mounted.current) return;
        if (!signal) throw problem;
        const outcome = failureStatus(problem, signal);
        setAttempt({ ...entry, status: outcome });
        retainPartial(text);
        if (atCallLimit && (text || toolApproval.result())) record(text, outcome);
        if (outcome === "failed") throw problem;
      } finally {
        controller.current = null;
        if (mounted.current) setStreaming("");
      }
    });
  }

  const retry =
    !busy && !pending && attempt && attempt.status !== "complete" ? lastRequest.current : null;
  const sameConnection =
    agent &&
    retry &&
    agent.path === retry.agent.path &&
    agent.revision === retry.agent.revision &&
    access === retry.access;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <fieldset
        disabled={pending !== null || !!requested || !!toolPending}
        className="flex min-w-0 flex-col gap-3"
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => void run(async () => setFound(await platform.discover()))}
          >
            {t("agent.discover")}
          </button>
          {agent && saved.some((item) => item.path === agent.path) ? (
            <button
              type="button"
              disabled={busy}
              className={buttonClass}
              onClick={() =>
                void run(async () => {
                  await platform.forget(agent.path);
                  const remaining = saved.filter((item) => item.path !== agent.path);
                  setSaved(remaining);
                  onConnectionsChanged?.(remaining);
                  select(remaining[0] ?? null);
                })
              }
            >
              {t("agent.forget")}
            </button>
          ) : null}
        </div>
        {(found || saved.length > 0) && (
          <div className="flex flex-col items-start gap-1">
            {found?.length === 0 && <p>{t("agent.noneFound")}</p>}
            {[...new Set([...saved.map((item) => item.path), ...(found ?? [])])].map(
              (candidate) => (
                <button
                  type="button"
                  key={candidate}
                  disabled={busy}
                  aria-pressed={agent?.path === candidate}
                  className={`${buttonClass} max-w-full break-all text-left`}
                  onClick={() => inspect(candidate)}
                >
                  {candidate}
                </button>
              ),
            )}
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) inspect(path);
          }}
        >
          <label className="min-w-40 flex-1">
            {t("agent.executable")}
            <input
              className={fieldClass}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <button type="submit" className={buttonClass} disabled={busy || !path.trim()}>
            {t("agent.inspect")}
          </button>
        </form>
        {agent && (
          <form
            className="flex flex-col gap-2 border-t border-(--mint-border) pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                busy ||
                !preferences.available ||
                picker.incomplete ||
                named.loading ||
                named.unconfirmed ||
                (showCallPlan && callLimit.invalid)
              )
                return;
              const request = {
                instruction: selection === undefined ? sampleInstruction : instruction.trim(),
                preferences: preferences.request,
                selectedText: material,
                responseFormat:
                  access === "taskCopy" && selection === undefined
                    ? ("replacement" as const)
                    : undefined,
                taskContext: selectedContext,
              };
              if (!request.instruction) return;
              const limit = showCallPlan ? callLimit.limit : undefined;
              if (agent.approved.includes(access)) send(agent, request, false, picker.plan, limit);
              else {
                setStatus(null);
                setError(null);
                setReply("");
                lastRequest.current = { agent, access, request, callLimit: limit };
                setPending({
                  id: crypto.randomUUID(),
                  request,
                  tool: picker.plan,
                  callLimit: limit,
                });
              }
            }}
          >
            {!materialsPlatform && (
              <p className="break-all">{t("agent.recipient", { path: agent.path })}</p>
            )}
            <label>
              {t("agent.access")}
              <select
                className={fieldClass}
                value={access}
                disabled={busy}
                onChange={(event) => {
                  picker.clear();
                  setAccess(event.target.value as AgentAccess);
                  setReply("");
                  setStatus(null);
                  setError(null);
                }}
              >
                <option value="readOnly">{t("agent.readOnly")}</option>
                {(agent.supportsTaskCopy || access === "taskCopy") && (
                  <option value="taskCopy">{t("agent.taskCopy")}</option>
                )}
                <option value="configured">{t("agent.configured")}</option>
              </select>
            </label>
            <ExternalAgentAccessNotice access={access} />
            {materialsPlatform ? (
              <fieldset disabled={busy}>
                <TaskContextChecklist
                  platform={materialsPlatform}
                  named={named}
                  recipient={t("writing.recipient.agent", { path: agent.path })}
                  selection={material}
                />
              </fieldset>
            ) : (
              <>
                <p className="font-medium">{t("agent.material")}</p>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-(--mint-hover) p-2 text-sm">
                  {material}
                </pre>
              </>
            )}
            {selection === undefined ? (
              <p>{sampleInstruction}</p>
            ) : (
              <label>
                {t("agent.instruction")}
                <input
                  className={fieldClass}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
              </label>
            )}
            {materialsPlatform && (
              <>
                <WritingPreferences
                  preferences={preferences}
                  correction={instruction}
                  disabled={busy}
                />
                <WritingToolPicker picker={picker} />
              </>
            )}
            {showCallPlan && (
              <WritingCallPlan
                recipient={t("writing.recipient.agent", { path: agent.path })}
                requests={[{ selectedText: material, taskContext: selectedContext }]}
                limit={callLimit}
                toolEndpoint={picker.plan?.endpoint}
              />
            )}
            <div>
              <button
                type="submit"
                ref={sendButton}
                className={buttonClass}
                disabled={
                  busy ||
                  !preferences.available ||
                  picker.incomplete ||
                  named.loading ||
                  named.unconfirmed ||
                  (showCallPlan && callLimit.invalid) ||
                  (selection !== undefined && !instruction.trim())
                }
              >
                {picker.plan?.exact
                  ? t("mcp.send", {
                      send: t("agent.send"),
                      effect: t(`mcp.effect.${picker.plan.effect}`),
                    })
                  : t(selection === undefined ? "agent.try" : "agent.send")}
              </button>
            </div>
            <p>
              {t(
                access === "taskCopy"
                  ? agent.verified.includes(access)
                    ? "agent.taskCopyVerified"
                    : "agent.taskCopyUnverified"
                  : agent.verified.includes(access)
                    ? "agent.verified"
                    : "agent.unverified",
              )}
            </p>
            <p className="text-(--mint-muted)">
              {t(access === "taskCopy" ? "agent.taskCopyFolder" : "agent.unsupported")}
            </p>
          </form>
        )}
      </fieldset>
      {agent && pending && (
        <fieldset className="flex min-w-0 flex-col gap-2 rounded border border-(--mint-border) p-3">
          <legend className="px-1 font-medium">
            {t(agent.approved.length ? "agent.expand" : "agent.allow")}
          </legend>
          <p>
            {t("agent.consent", {
              path: agent.path,
              access: t(`agent.${access}`),
            })}
          </p>
          {pending.request.preferences && (
            <AppliedWritingPreferences preferences={pending.request.preferences} />
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              ref={declineButton}
              className={buttonClass}
              onClick={() => {
                setPending(null);
                picker.clear();
                setStatus("agent.declined");
              }}
            >
              {t("agent.decline")}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => send(agent, pending.request, true, pending.tool, pending.callLimit)}
            >
              {t("agent.allowSend")}
            </button>
          </div>
        </fieldset>
      )}
      {pause && <WritingCallPause pause={pause} />}
      {toolPending && <WritingToolNotice pending={toolPending} onDecision={toolApproval.decide} />}
      <WritingToolOutcome outcome={toolApproval.outcome} />
      {requested && materialsPlatform && (
        <MaterialRequestNotice
          key={requested.id}
          pending={requested}
          platform={materialsPlatform}
          onDecision={materialRequests.decide}
        />
      )}
      {target &&
        (taskStatus === "approval" || taskStatus === "working" || taskStatus === "paused") && (
          <button type="button" className={buttonClass} onClick={stop}>
            {t("writing.task.stop")}
          </button>
        )}
      {attempt && !busy && !pending && attempt.status !== "complete" && (
        <p role="status">{t(`writing.task.${attempt.status}`)}</p>
      )}
      {sameConnection && (
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            if (agent.approved.includes(access))
              send(agent, retry.request, false, undefined, retry.callLimit);
            else
              setPending({
                id: crypto.randomUUID(),
                request: retry.request,
                callLimit: retry.callLimit,
              });
          }}
        >
          {t("writing.task.retry")}
        </button>
      )}
      {(partial.length > 0 || streaming) && (
        <section
          aria-label={t("writing.task.partial")}
          className="whitespace-pre-wrap wrap-anywhere"
        >
          {partial.map(({ id, text }) => (
            <p key={id}>{text}</p>
          ))}
          {streaming && <p>{streaming}</p>}
        </section>
      )}
      {(busy || status || (reply && !renderReply)) && (
        <div role="status" className="whitespace-pre-wrap break-words">
          {busy ? t("agent.working") : status ? t(status) : reply}
        </div>
      )}
      {!busy && !status && reply && renderReply?.(reply)}
      {error && <p role="alert">{t(error)}</p>}
    </div>
  );
}
