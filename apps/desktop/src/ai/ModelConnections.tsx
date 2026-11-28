import { type FormEvent, useEffect, useId, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { ConnectionSection } from "./ConnectionSection.tsx";
import { modelEndpoint, modelWritingSender, type SavedModelConnection } from "./model.ts";
import { replacementFromReply } from "./writing-sender.ts";

const presets = {
  custom: { label: "models.custom", address: "" },
  openai: { label: "models.openai", address: "https://api.openai.com/v1" },
  deepseek: { label: "models.deepseek", address: "https://api.deepseek.com" },
  ollama: { label: "models.ollama", address: "http://127.0.0.1:11434/v1" },
} as const;
type Preset = keyof typeof presets;

const retentionPolicies: Readonly<
  Record<string, { message: MessageKey; url: string } | undefined>
> = {
  "https://api.openai.com": {
    message: "models.retention.openai",
    url: "https://developers.openai.com/api/docs/guides/your-data",
  },
  "https://api.deepseek.com": {
    message: "models.retention.deepseek",
    url: "https://api-docs.deepseek.com/guides/kv_cache/",
  },
  "http://127.0.0.1:11434": {
    message: "models.retention.ollama",
    url: "https://docs.ollama.com/faq",
  },
};

const fieldClass =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
const buttonClass =
  "rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

export function useModelConnections(platform: Platform) {
  const [connections, setConnections] = useState<readonly SavedModelConnection[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void platform.listModelConnections().then(
      (saved) => {
        if (active) setConnections(saved);
      },
      () => {
        if (active) {
          setLoadFailed(true);
          setConnections([]);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [platform]);
  return {
    connections,
    loadFailed,
    add: (saved: SavedModelConnection) =>
      setConnections((previous) => [...(previous ?? []), saved]),
    remove: (id: string) =>
      setConnections((previous) => previous?.filter((item) => item.id !== id) ?? []),
  };
}

export function ModelConnections({
  platform,
  models: { connections, loadFailed, add, remove },
}: {
  readonly platform: Platform;
  readonly models: ReturnType<typeof useModelConnections>;
}) {
  const t = useT();
  return (
    <ConnectionSection title={t("models.title")}>
      {loadFailed && (
        <p role="alert" className="px-3">
          {t("models.error.connections")}
        </p>
      )}
      {connections && <ModelTrial platform={platform} onSaved={add} />}
      {connections?.map((connection) => (
        <section
          key={connection.id}
          aria-label={connection.name}
          className="space-y-2 border-t border-(--mint-border) pt-3"
        >
          <div className="px-3 text-sm wrap-anywhere">
            <h3 className="font-medium">{connection.name}</h3>
            <p>{connection.address}</p>
            {connection.keySuffix !== null && <p>••••{connection.keySuffix}</p>}
            <p className="text-xs text-(--mint-muted)">
              {t(connection.lifetime === "session" ? "models.session" : "models.remembered")}
            </p>
          </div>
          <ModelTrial
            platform={platform}
            connection={connection}
            onDisconnected={() => remove(connection.id)}
          />
        </section>
      ))}
    </ConnectionSection>
  );
}

interface TrialResult {
  readonly text: string;
  readonly streamed: boolean;
  readonly proposedEdit: boolean;
}

function ModelTrial({
  platform,
  connection,
  onSaved,
  onDisconnected,
}: {
  readonly platform: Platform;
  readonly connection?: SavedModelConnection;
  readonly onSaved?: (connection: SavedModelConnection) => void;
  readonly onDisconnected?: () => void;
}) {
  const t = useT();
  const [preset, setPreset] = useState<Preset>("custom");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [trialClearedKey, setTrialClearedKey] = useState(false);
  const [stream, setStream] = useState(true);
  const [activity, setActivity] = useState<"sample" | "storage" | null>(null);
  const [partial, setPartial] = useState("");
  const [result, setResult] = useState<TrialResult | null>(null);
  const [error, setError] = useState("");
  const sample = t("models.sample");
  const addressHintId = useId();
  const keyHintId = useId();
  let endpoint = "";
  try {
    endpoint = modelEndpoint(connection?.address ?? address);
  } catch {
    // The action stays disabled until the service address is valid.
  }
  const retention = endpoint ? retentionPolicies[new URL(endpoint).origin] : undefined;

  function clearResult() {
    setPartial("");
    setResult(null);
    setError("");
  }

  const canRun = !!endpoint && (!!connection || !!model.trim());
  const needsKeyToSave = trialClearedKey && !apiKey.trim();
  const canSave = canRun && !!name.trim() && !needsKeyToSave;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activity || !canRun) return;
    clearResult();
    setActivity("sample");
    if (apiKey.trim()) setTrialClearedKey(true);
    setApiKey("");
    try {
      const send = modelWritingSender(
        platform.sendModelMessage,
        connection ? { id: connection.id } : { address, model },
        {
          apiKey,
          onDelta: stream ? (text) => setPartial((previous) => previous + text) : undefined,
        },
      );
      const reply = await send({ instruction: sample });
      const replacement = replacementFromReply(reply)?.trim();
      setResult({
        text: replacement || reply.text,
        streamed: reply.streamed,
        proposedEdit: !!replacement,
      });
    } catch (error) {
      setError(
        t(failureMessage(error), { status: typeof error === "number" ? String(error) : "" }),
      );
    } finally {
      setActivity(null);
    }
  }

  async function save(lifetime: SavedModelConnection["lifetime"]) {
    if (activity || !canSave) return;
    setActivity("storage");
    setError("");
    try {
      const saved = await platform.saveModelConnection({ name, address, model, apiKey, lifetime });
      setName("");
      setApiKey("");
      setTrialClearedKey(false);
      onSaved?.(saved);
    } catch (error) {
      setError(
        t(error === "credentialStoreUnavailable" ? "models.error.remember" : failureMessage(error)),
      );
    } finally {
      setActivity(null);
    }
  }

  async function disconnect() {
    if (activity || !connection) return;
    setActivity("storage");
    setError("");
    try {
      await platform.disconnectModelConnection(connection.id);
      onDisconnected?.();
    } catch (error) {
      setError(t(failureMessage(error)));
    } finally {
      setActivity(null);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 px-3 pb-3 text-sm">
      <fieldset disabled={activity !== null} className="space-y-3">
        {!connection && (
          <>
            <label className="block">
              {t("models.service")}
              <select
                className={fieldClass}
                value={preset}
                onChange={(event) => {
                  const selected = event.target.value as Preset;
                  setPreset(selected);
                  setAddress(presets[selected].address);
                  setModel("");
                  setApiKey("");
                  setTrialClearedKey(false);
                  clearResult();
                }}
              >
                {Object.entries(presets).map(([id, { label }]) => (
                  <option key={id} value={id}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              {t("models.address")}
              <input
                type="url"
                aria-describedby={addressHintId}
                aria-invalid={Boolean(address && !endpoint)}
                className={fieldClass}
                autoComplete="off"
                spellCheck={false}
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setApiKey("");
                  setTrialClearedKey(false);
                  clearResult();
                }}
              />
            </label>
            <p id={addressHintId} className="text-xs text-(--mint-muted)">
              {t(address && !endpoint ? "models.error.address" : "models.addressHint")}
            </p>
            <label className="block">
              {t("models.model")}
              <input
                className={fieldClass}
                autoComplete="off"
                spellCheck={false}
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  clearResult();
                }}
              />
            </label>
            <label className="block">
              {t("models.key")}
              <input
                type="password"
                className={fieldClass}
                autoComplete="off"
                aria-describedby={keyHintId}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <p id={keyHintId} className="text-xs text-(--mint-muted)">
              {t(needsKeyToSave ? "models.reenterKey" : "models.keyHint")}
            </p>
            <label className="block">
              {t("models.name")}
              <input
                className={fieldClass}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </>
        )}
        <label className="block">
          {t("models.prompt")}
          <textarea readOnly rows={3} className={fieldClass} value={sample} />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-(--mint-accent)"
            checked={stream}
            onChange={(event) => {
              setStream(event.target.checked);
              clearResult();
            }}
          />
          {t("models.requestStreaming")}
        </label>
        {endpoint && (
          <>
            <p className="wrap-anywhere text-xs text-(--mint-muted)">
              {t("models.recipient", { endpoint })}
            </p>
            <details className="space-y-1 text-xs text-(--mint-muted)">
              <summary>{t("models.retention")}</summary>
              <p>{t(retention?.message ?? "models.retention.custom")}</p>
              {retention && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => void platform.openExternal(retention.url)}
                >
                  {t("models.retention.policy")}
                </button>
              )}
            </details>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={!canRun} className={buttonClass}>
            {t(activity === "sample" ? "models.running" : "models.run")}
          </button>
          {connection ? (
            <button type="button" onClick={disconnect} className={buttonClass}>
              {t("models.disconnect")}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => save("persistent")}
                className={buttonClass}
              >
                {t("models.remember")}
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => save("session")}
                className={buttonClass}
              >
                {t("models.session")}
              </button>
            </>
          )}
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite" aria-busy={activity === "sample"} hidden={!result && !partial}>
        <p>{t(error ? "models.partial" : "models.reply")}</p>
        <p className="whitespace-pre-wrap wrap-anywhere rounded-md bg-(--mint-hover) p-2">
          {result?.text ?? partial}
        </p>
      </div>
      <ul aria-label={t("models.capabilities")} className="space-y-1 text-xs text-(--mint-muted)">
        <li>
          {t("models.conversation", { state: t(result ? "models.verified" : "models.unverified") })}
        </li>
        <li>
          {t("models.streaming", {
            state: t(result?.streamed ? "models.verified" : "models.unverified"),
          })}
        </li>
        <li>
          {t("models.proposedEdit", {
            state: t(result?.proposedEdit ? "models.verified" : "models.unverified"),
          })}
        </li>
        <li>{t("models.multiFile", { state: t("models.unavailable") })}</li>
      </ul>
    </form>
  );
}

function failureMessage(error: unknown): MessageKey {
  if (error === "credentialStoreUnavailable") return "models.error.credentialStore";
  if (error === "credentialMissing") return "models.error.credentialMissing";
  if (error === "connectionMissing") return "models.error.connectionMissing";
  if (error === "connectionsUnavailable") return "models.error.connections";
  switch (error) {
    case 401:
    case 403:
    case "invalidKey":
      return "models.error.key";
    case 404:
      return "models.error.notFound";
    case 429:
    case "limit":
      return "models.error.rateLimit";
    case "invalidAddress":
      return "models.error.address";
    case "invalidReply":
      return "models.error.reply";
    case "interrupted":
      return "models.error.interrupted";
    case "timeout":
      return "models.error.timeout";
    default:
      return typeof error === "number" ? "models.error.http" : "models.error.network";
  }
}
