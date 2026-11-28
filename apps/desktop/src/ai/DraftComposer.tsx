import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { ExternalAgentAccessNotice } from "./ExternalAgentPanel.tsx";
import { type ExternalAgent, externalAgentSender } from "./external-agent.ts";
import { MaterialRequestNotice, useMaterialRequests } from "./MaterialRequest.tsx";
import { modelEndpoint, modelWritingSender, type SavedModelConnection } from "./model.ts";
import { TaskContextChecklist, useNamedMaterials } from "./TaskContext.tsx";

const field =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const button =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

export function DraftComposer({
  platform,
  folder,
  settingsOpen,
  canApplyDraft,
  onDraft,
  onClose,
}: {
  readonly platform: Platform;
  readonly folder: string | null;
  readonly settingsOpen: boolean;
  readonly canApplyDraft: () => boolean;
  readonly onDraft: (text: string) => boolean;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [instruction, setInstruction] = useState("");
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [models, setModels] = useState<readonly SavedModelConnection[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [unapplied, setUnapplied] = useState("");
  const named = useNamedMaterials();
  const [allowedFolder, setAllowedFolder] = useState<string | null>(null);
  const searchFolder = allowedFolder === folder ? folder : null;
  const materialRequests = useMaterialRequests();
  const agent = agents.find(({ path }) => `agent:${path}` === choice);
  const remembered = models.find(({ id }) => `model:${id}` === choice);
  const custom = !choice;
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

  useEffect(() => {
    input.current?.focus();
    return () => {
      generation.current++;
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) return;
    let mounted = true;
    void platform.listModelConnections().then(
      (saved) => {
        if (!mounted) return;
        setModels(saved);
        const first = saved[0];
        if (first) setChoice((previous) => previous ?? `model:${first.id}`);
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

  const canSend =
    !!instruction.trim() &&
    !named.loading &&
    (!!agent || (!!endpoint && (!!remembered || (custom && !!model.trim()))));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canSend || unapplied) return;
    if (!canApplyDraft()) {
      setError("draft.requiresEmptyUntitled");
      return;
    }
    const request = ++generation.current;
    setError(null);
    setBusy(true);
    try {
      const send = agent
        ? externalAgentSender(platform.externalAgent, agent, agent.preferredAccess)
        : remembered
          ? modelWritingSender(platform.sendModelMessage, remembered)
          : modelWritingSender(platform.sendModelMessage, { address, model }, { apiKey: key });
      const reply = await materialRequests.send(
        send,
        {
          instruction: t("draft.prompt", { instruction: instruction.trim() }),
          taskContext:
            named.materials.length || searchFolder
              ? {
                  materials: named.materials.length ? named.materials : undefined,
                  folderSearch: searchFolder ? true : undefined,
                }
              : undefined,
        },
        recipient ?? "",
        searchFolder,
      );
      if (request !== generation.current) return;
      if (
        !reply.text.trim() ||
        ("finishReason" in reply && reply.finishReason !== null && reply.finishReason !== "stop")
      ) {
        throw "incomplete";
      }
      if (onDraft(reply.text)) onClose();
      else {
        setUnapplied(reply.text);
        setError("draft.changed");
      }
    } catch (error) {
      if (request !== generation.current) return;
      const code = error instanceof Error ? error.message : error;
      setError(
        code === "agentChanged" || code === "agentAccessRequired"
          ? "agent.reviewAgain"
          : code === "connectionMissing"
            ? "draft.connectionUnavailable"
            : "draft.failed",
      );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  return (
    <form
      aria-labelledby={id}
      onSubmit={submit}
      className="max-h-[70%] shrink-0 space-y-2 overflow-auto border-b border-(--mint-border) px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="font-medium">
          {t("command.file.draftWithAi")}
        </h2>
        <button type="button" className={button} onClick={onClose}>
          {t("settings.close")}
        </button>
      </div>
      <fieldset disabled={busy || !!unapplied} className="space-y-2">
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
              value={choice ?? ""}
              onChange={(event) => {
                setChoice(event.target.value);
                setKey("");
                setAllowedFolder(null);
              }}
            >
              <option value="">{t("models.custom")}</option>
              {unavailable && (
                <option value={choice ?? ""} disabled>
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
          folder={folder}
          searchEnabled={!!searchFolder}
          onSearchChange={(checked) => setAllowedFolder(checked ? folder : null)}
        />
        {agent && (
          <details className="space-y-1 text-xs text-(--mint-muted)">
            <summary>
              {t(agent.preferredAccess === "readOnly" ? "agent.readOnly" : "agent.configured")}
            </summary>
            <ExternalAgentAccessNotice access={agent.preferredAccess} />
          </details>
        )}
        <button type="submit" disabled={!canSend} className={button}>
          {t("draft.generate")}
        </button>
      </fieldset>
      {materialRequests.pending ? (
        <MaterialRequestNotice
          key={materialRequests.pending.id}
          pending={materialRequests.pending}
          platform={platform}
          onDecision={materialRequests.decide}
        />
      ) : (
        busy && <p role="status">{t("draft.generating")}</p>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {unapplied && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">{unapplied}</pre>
      )}
    </form>
  );
}
