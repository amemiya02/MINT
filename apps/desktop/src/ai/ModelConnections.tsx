import { type FormEvent, useId, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { ConnectionSection } from "./ConnectionSection.tsx";
import { modelEndpoint, modelWritingSender } from "./model.ts";

const presets = {
  custom: { label: "models.custom", address: "" },
  openai: { label: "models.openai", address: "https://api.openai.com/v1" },
  deepseek: { label: "models.deepseek", address: "https://api.deepseek.com" },
  ollama: { label: "models.ollama", address: "http://127.0.0.1:11434/v1" },
} as const;
type Preset = keyof typeof presets;

const fieldClass =
  "w-full rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

export function ModelConnections({ platform }: { readonly platform: Platform }) {
  const t = useT();
  return (
    <ConnectionSection title={t("models.title")}>
      <ModelTrial platform={platform} />
    </ConnectionSection>
  );
}

interface TrialResult {
  readonly text: string;
  readonly streamed: boolean;
  readonly proposedEdit: boolean;
}

function ModelTrial({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const [preset, setPreset] = useState<Preset>("custom");
  const [address, setAddress] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [stream, setStream] = useState(true);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState("");
  const [result, setResult] = useState<TrialResult | null>(null);
  const [error, setError] = useState("");
  const sample = t("models.sample");
  const addressHintId = useId();
  let endpoint = "";
  try {
    endpoint = modelEndpoint(address);
  } catch {
    // The action stays disabled until the service address is valid.
  }

  function clearResult() {
    setPartial("");
    setResult(null);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !endpoint || !model.trim()) return;
    clearResult();
    setBusy(true);
    setApiKey("");
    try {
      const send = modelWritingSender(
        platform.sendModelMessage,
        { address, model },
        {
          apiKey,
          onDelta: stream ? (text) => setPartial((previous) => previous + text) : undefined,
        },
      );
      const reply = await send({ instruction: sample });
      const replacement =
        reply.finishReason === null || reply.finishReason === "stop"
          ? /^<replacement>([\s\S]+)<\/replacement>$/.exec(reply.text.trim())?.[1]?.trim()
          : undefined;
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
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 px-3 pb-3 text-sm">
      <fieldset disabled={busy} className="space-y-3">
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
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
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
          <p className="wrap-anywhere text-xs text-(--mint-muted)">
            {t("models.recipient", { endpoint })}
          </p>
        )}
        <button
          type="submit"
          disabled={!endpoint || !model.trim()}
          className="rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50"
        >
          {t(busy ? "models.running" : "models.run")}
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite" aria-busy={busy} hidden={!result && !partial}>
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
  switch (error) {
    case 401:
    case 403:
    case "invalidKey":
      return "models.error.key";
    case 404:
      return "models.error.notFound";
    case 429:
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
