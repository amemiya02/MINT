import type { MintEditor } from "@mint/editor";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { type ExternalAgent, externalAgentSender } from "./external-agent.ts";
import type { WritingTurn } from "./writing-sender.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";
const fieldClass =
  "min-w-0 rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

const scopes = ["selection", "document", "instruction"] as const;
type Scope = (typeof scopes)[number];

interface Origin {
  readonly id: number;
  readonly editor: MintEditor;
  readonly text: string;
  readonly range: ReturnType<MintEditor["trackRange"]>;
}

interface Turn extends WritingTurn {
  readonly material?: string;
  readonly recipient: string;
}

interface Props {
  readonly editor: MintEditor | null;
  readonly name: string;
  readonly active: boolean;
  readonly platform: Platform;
  readonly askRequest: number | null;
  readonly settingsOpen: boolean;
  readonly onAsk: () => void;
  readonly onSettings: () => void;
  readonly children: ReactNode;
}

/** The editor owns its selection and scroll position, while the composer retains the task material. */
export function WritingAssistant({
  editor,
  name,
  active,
  platform,
  askRequest,
  settingsOpen,
  onAsk,
  onSettings,
  children,
}: Props) {
  const t = useT();
  const [hasSelection, setHasSelection] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
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
    const { anchor, head } = editor.getSelection();
    if (anchor === head) return;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    setOrigin({
      id: askRequest,
      editor,
      text: editor.getText().slice(from, to),
      range: editor.trackRange({ from, to }),
    });
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
          name={name}
          placement={placement}
          setPlacement={setPlacement}
          platform={platform}
          settingsOpen={settingsOpen}
          onSettings={onSettings}
        />
      )}
    </div>
  );
}

function Composer({
  origin,
  name,
  placement,
  setPlacement,
  platform,
  settingsOpen,
  onSettings,
}: Pick<Props, "name" | "platform" | "settingsOpen" | "onSettings"> & {
  readonly origin: Origin;
  readonly placement: "inline" | "sidebar" | null;
  readonly setPlacement: (placement: "inline" | "sidebar" | null) => void;
}) {
  const t = useT();
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<Scope>("selection");
  const [documentText, setDocumentText] = useState("");
  const [includeHistory, setIncludeHistory] = useState(true);
  const [agents, setAgents] = useState<readonly ExternalAgent[]>([]);
  const [recipientPath, setRecipientPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"sendFailed" | "agentChanged" | "missingSelection" | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const recipient = agents.find((agent) => agent.path === recipientPath);
  const material =
    scope === "selection" ? origin.text : scope === "document" ? documentText : undefined;

  useEffect(() => {
    if (settingsOpen) return;
    let current = true;
    setLoading(true);
    setLoadFailed(false);
    void platform.externalAgent.saved().then(
      (saved) => {
        if (!current) return;
        const available = saved.filter((agent) => agent.approved.includes(agent.preferredAccess));
        setAgents(available);
        setRecipientPath((previous) => previous ?? available[0]?.path ?? null);
        setLoading(false);
      },
      () => {
        if (!current) return;
        setAgents([]);
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [platform, settingsOpen]);

  useEffect(() => {
    if (placement && !settingsOpen) input.current?.focus();
  }, [placement, settingsOpen]);

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!instruction.trim() || !recipient || busy || loading) return;
    const prompt = instruction.trim();
    const history =
      includeHistory && turns.length
        ? turns.map(({ instruction, reply }) => ({ instruction, reply }))
        : undefined;
    setBusy(true);
    setError(null);
    if (placement === "inline") origin.editor.focus();

    try {
      const send = externalAgentSender(
        platform.externalAgent,
        recipient,
        recipient.preferredAccess,
      );
      const result = await send({ instruction: prompt, selectedText: material, history });
      setTurns((previous) => [
        ...previous,
        { instruction: prompt, reply: result.text, material, recipient: recipient.path },
      ]);
      setInstruction("");
    } catch (problem) {
      const code = problem instanceof Error ? problem.message : problem;
      setError(
        code === "agentAccessRequired" || code === "agentChanged" ? "agentChanged" : "sendFailed",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!placement) return null;
  const sidebar = placement === "sidebar";
  const Container = sidebar ? "aside" : "section";
  const messages = sidebar ? turns : turns.slice(-1);

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
      <div aria-live="polite" className="space-y-2">
        {messages.map((turn, index) => (
          <article key={sidebar ? index : turns.length} className="space-y-1">
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
            <pre className="whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2">
              {turn.reply}
            </pre>
          </article>
        ))}
        {busy && <p>{t("agent.working")}</p>}
      </div>
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
                <select className={fieldClass} defaultValue="comment">
                  <option value="comment">{t("writing.comment")}</option>
                </select>
              </label>
              <label className="grid gap-1">
                {t("writing.scope")}
                <select
                  className={fieldClass}
                  value={scope}
                  onChange={(event) => {
                    const next = event.target.value as Scope;
                    if (next === "document")
                      setDocumentText(origin.editor.getText().replace(/^\uFEFF/, ""));
                    setScope(next);
                  }}
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
                  value={recipient?.path ?? ""}
                  onChange={(event) => setRecipientPath(event.target.value)}
                >
                  {!recipient && (
                    <option value="">
                      {t(loading ? "writing.loading" : "writing.chooseRecipient")}
                    </option>
                  )}
                  {agents.map((agent) => (
                    <option key={agent.path} value={agent.path}>
                      {t("agent.recipient", { path: agent.path })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {recipient && (
              <p className="text-xs text-(--mint-muted)">
                {t("agent.processAccess")}{" "}
                {t(
                  recipient.preferredAccess === "readOnly"
                    ? "agent.readOnlyAccess"
                    : "agent.configuredAccess",
                )}{" "}
                {t("agent.tools")}
              </p>
            )}
            {loadFailed && <p role="alert">{t("agent.loadFailed")}</p>}
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
