import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { materialBytes } from "./MaterialCapacity.tsx";
import type { WritingRequest } from "./writing-sender.ts";

export function useWritingCallLimit() {
  const [value, setValue] = useState("");
  const limit = value === "" ? undefined : Number(value);
  const invalid = limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1);
  return { value, setValue, limit, invalid };
}

export function WritingCallPlan({
  recipient,
  requests,
  limit,
  toolEndpoint,
  fixed,
}: {
  readonly recipient: string;
  readonly requests: readonly Pick<WritingRequest, "selectedText" | "taskContext">[];
  readonly limit: ReturnType<typeof useWritingCallLimit>;
  readonly toolEndpoint?: string;
  readonly fixed?: boolean;
}) {
  const t = useT();
  const bytes = requests.reduce((total, request) => total + materialBytes(request), 0);
  return (
    <fieldset className="space-y-1 rounded border border-(--mint-border) p-2 text-xs">
      <legend>{t("writing.calls.plan")}</legend>
      <p className="wrap-anywhere">{recipient}</p>
      <p>{t("writing.calls.material", { bytes: bytes.toLocaleString() })}</p>
      <p>{t(requests.length === 1 ? "writing.calls.one" : "writing.calls.planned", {
        count: String(requests.length),
      })}</p>
      {toolEndpoint && (
        <p className="wrap-anywhere">{t("writing.calls.tool", { endpoint: toolEndpoint })}</p>
      )}
      {!fixed && requests.some(({ taskContext }) => !!taskContext) && (
        <p>{t("writing.calls.materialFollowup")}</p>
      )}
      <label className="flex flex-wrap items-center gap-2">
        {t("writing.calls.limit")}
        <input
          type="number"
          min={1}
          step={1}
          className="w-24 rounded border border-(--mint-border) bg-(--mint-bg) p-1"
          value={limit.value}
          aria-invalid={limit.invalid || undefined}
          onChange={(event) => limit.setValue(event.target.value)}
        />
      </label>
      {limit.invalid && <p role="status">{t("writing.calls.invalid")}</p>}
    </fieldset>
  );
}

interface CallPause {
  readonly recipient: string;
  readonly calls: number;
  readonly completed: string;
  decide(allow: boolean): void;
}

export function useWritingCallBudget() {
  const [paused, setPaused] = useState<CallPause | null>(null);
  return {
    paused,
    start(
      limit: number | undefined,
      signal: AbortSignal | undefined,
      onPause?: (completed: string) => void,
      onResume?: (completed: string) => void,
    ) {
      let calls = 0;
      return async (recipient: string, completed: string) => {
        signal?.throwIfAborted();
        if (limit !== undefined && calls >= limit) {
          const allowed = await new Promise<boolean>((resolve) => {
            const decide = (allow: boolean) => {
              signal?.removeEventListener("abort", abort);
              resolve(allow);
            };
            const abort = () => decide(false);
            signal?.addEventListener("abort", abort, { once: true });
            setPaused({ recipient, calls, completed, decide });
            onPause?.(completed);
          });
          setPaused(null);
          signal?.throwIfAborted();
          if (!allowed) throw "callLimit";
          limit++;
          onResume?.(completed);
        }
        calls++;
      };
    },
  };
}

export function WritingCallPause({ pause }: { readonly pause: CallPause }) {
  const t = useT();
  const button = "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover)";
  return (
    <fieldset className="space-y-2 rounded border border-(--mint-border) p-2 text-sm">
      <legend>{t("writing.calls.paused")}</legend>
      <p role="status">{t("writing.calls.used", { count: String(pause.calls) })}</p>
      <p className="wrap-anywhere">{t("writing.calls.next", { recipient: pause.recipient })}</p>
      {pause.completed && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere">
          {pause.completed}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => pause.decide(true)}>
          {t("writing.calls.allow")}
        </button>
        <button type="button" className={button} onClick={() => pause.decide(false)}>
          {t("writing.calls.finish")}
        </button>
      </div>
    </fieldset>
  );
}
