import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { ConnectionSection } from "./ConnectionSection.tsx";
import {
  type AgentAccess,
  type ExternalAgent,
  type ExternalAgentPlatform,
  externalAgentSender,
} from "./external-agent.ts";
import type { WritingRequest } from "./writing-sender.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

interface Props {
  readonly platform: ExternalAgentPlatform;
  readonly selection?: string;
}

export function ExternalAgentAccessNotice({ access }: { readonly access: AgentAccess }) {
  const t = useT();
  return (
    <>
      <p>
        {t("agent.processAccess")}{" "}
        {t(access === "readOnly" ? "agent.readOnlyAccess" : "agent.configuredAccess")}
      </p>
      <p>{t("agent.tools")}</p>
      <p>{t("agent.usesLogin")}</p>
    </>
  );
}

export function ExternalAgentSettings({ platform }: { readonly platform: ExternalAgentPlatform }) {
  const t = useT();
  return (
    <ConnectionSection title={t("agent.title")} preserveContent>
      <div className="px-3 pb-3">
        <ExternalAgentPanel platform={platform} />
      </div>
    </ConnectionSection>
  );
}

export function ExternalAgentDialog({
  onClose,
  ...props
}: Props & { readonly onClose: () => void }) {
  const t = useT();
  const title = useId();
  const dialog = useModalDialog(onClose);
  return (
    <dialog
      {...dialog.props}
      aria-labelledby={title}
      className="m-auto max-h-[85vh] w-[min(32rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={title}>{t("agent.askTitle")}</h2>
        <button type="button" className={buttonClass} onClick={dialog.close}>
          {t("settings.close")}
        </button>
      </div>
      <ExternalAgentPanel {...props} />
    </dialog>
  );
}

function ExternalAgentPanel({ platform, selection }: Props) {
  const t = useT();
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<ExternalAgent | null>(null);
  const [access, setAccess] = useState<AgentAccess>("readOnly");
  const [saved, setSaved] = useState<ExternalAgent[]>([]);
  const [found, setFound] = useState<string[] | null>(null);
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<WritingRequest | null>(null);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [reply, setReply] = useState("");
  const declineButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const sampleInstruction = t("agent.sampleInstruction");
  const material = selection ?? t("agent.sampleText");

  const select = useCallback((next: ExternalAgent | null) => {
    setAgent(next);
    setAccess(next?.preferredAccess ?? "readOnly");
    setReply("");
  }, []);

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
        setError("agent.reviewAgain");
        if (agent) select(await platform.inspect(agent.path).catch(() => null));
      } else {
        setError(code === "agentUnavailable" ? "agent.unavailable" : "agent.failed");
      }
    } finally {
      setBusy(false);
    }
  }

  function inspect(candidate: string) {
    void run(async () => {
      select(await platform.inspect(candidate.trim()));
    });
  }

  function send(current: ExternalAgent, request: WritingRequest, approve: boolean) {
    setPending(null);
    setReply("");
    void run(async () => {
      const connection = approve ? await platform.approve(current, access) : current;
      if (approve) {
        setAgent(connection);
        setSaved((list) => [connection, ...list.filter((item) => item.path !== connection.path)]);
      }
      const result = await externalAgentSender(platform, connection, access)(request);
      const verified = {
        ...connection,
        preferredAccess: access,
        verified: [...new Set([...connection.verified, access])],
      };
      setAgent(verified);
      setSaved((list) => [verified, ...list.filter((item) => item.path !== verified.path)]);
      setReply(result.text);
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <fieldset disabled={pending !== null} className="flex min-w-0 flex-col gap-3">
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
              if (busy) return;
              const request = {
                instruction: selection === undefined ? sampleInstruction : instruction.trim(),
                selectedText: material,
              };
              if (!request.instruction) return;
              if (agent.approved.includes(access)) send(agent, request, false);
              else {
                setStatus(null);
                setError(null);
                setReply("");
                setPending(request);
              }
            }}
          >
            <p className="break-all">{t("agent.recipient", { path: agent.path })}</p>
            <label>
              {t("agent.access")}
              <select
                className={fieldClass}
                value={access}
                disabled={busy}
                onChange={(event) => {
                  setAccess(event.target.value === "configured" ? "configured" : "readOnly");
                  setReply("");
                  setStatus(null);
                  setError(null);
                }}
              >
                <option value="readOnly">{t("agent.readOnly")}</option>
                <option value="configured">{t("agent.configured")}</option>
              </select>
            </label>
            <ExternalAgentAccessNotice access={access} />
            <p className="font-medium">{t("agent.material")}</p>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-(--mint-hover) p-2 text-sm">
              {material}
            </pre>
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
            <div>
              <button
                type="submit"
                ref={sendButton}
                className={buttonClass}
                disabled={busy || (selection !== undefined && !instruction.trim())}
              >
                {t(selection === undefined ? "agent.try" : "agent.send")}
              </button>
            </div>
            <p>{t(agent.verified.includes(access) ? "agent.verified" : "agent.unverified")}</p>
            <p className="text-(--mint-muted)">{t("agent.unsupported")}</p>
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
              access: t(access === "readOnly" ? "agent.readOnly" : "agent.configured"),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              ref={declineButton}
              className={buttonClass}
              onClick={() => {
                setPending(null);
                setStatus("agent.declined");
              }}
            >
              {t("agent.decline")}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => send(agent, pending, true)}
            >
              {t("agent.allowSend")}
            </button>
          </div>
        </fieldset>
      )}
      {(busy || status || reply) && (
        <div role="status" className="whitespace-pre-wrap break-words">
          {busy ? t("agent.working") : status ? t(status) : reply}
        </div>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </div>
  );
}
