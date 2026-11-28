import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { materialBytes } from "./MaterialCapacity.tsx";
import type { WritingRequest } from "./writing-sender.ts";

const utf8 = new TextEncoder();

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
  folderFileCount,
  disabled,
}: {
  readonly recipient: string;
  readonly requests: readonly Pick<
    WritingRequest,
    "selectedText" | "taskContext" | "folderDocuments"
  >[];
  readonly limit: ReturnType<typeof useWritingCallLimit>;
  readonly toolEndpoint?: string;
  readonly fixed?: boolean;
  readonly folderFileCount?: number;
  readonly disabled?: boolean;
}) {
  const t = useT();
  const bytes = requests.reduce(
    (total, request) =>
      total +
      materialBytes(request) +
      (request.folderDocuments?.reduce((sum, { text }) => sum + utf8.encode(text).length, 0) ?? 0),
    0,
  );
  return (
    <fieldset
      disabled={disabled}
      className="space-y-1 rounded border border-(--mint-border) p-2 text-xs"
    >
      <legend>{t("writing.calls.plan")}</legend>
      <p className="wrap-anywhere">{recipient}</p>
      {folderFileCount !== undefined && (
        <p>
          {t(folderFileCount === 1 ? "writing.calls.folderOne" : "writing.calls.folderFiles", {
            count: String(folderFileCount),
          })}
        </p>
      )}
      {(bytes > 0 || folderFileCount === undefined) && (
        <p>{t("writing.calls.material", { bytes: bytes.toLocaleString() })}</p>
      )}
      <p>
        {t(requests.length === 1 ? "writing.calls.one" : "writing.calls.planned", {
          count: String(requests.length),
        })}
      </p>
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
          placeholder={t("writing.calls.unlimited")}
          aria-invalid={limit.invalid || undefined}
          onChange={(event) => limit.setValue(event.target.value)}
        />
      </label>
      {limit.invalid && <p role="status">{t("writing.calls.invalid")}</p>}
      {!fixed && <p>{t("writing.calls.scope")}</p>}
    </fieldset>
  );
}

interface CallPause {
  readonly recipient: string;
  readonly calls: number;
  readonly completed: string;
  decide(allow: boolean): void;
}

export interface WritingCallUsage {
  readonly totalTokens: number;
  readonly reportedCalls: number;
  readonly repeatedInputTokens: number;
  readonly repeatedCalls: number;
}

export function WritingReportedUsage({ usage }: { readonly usage?: WritingCallUsage | null }) {
  const t = useT();
  if (!usage) return null;
  return (
    <p className="text-xs">
      {t(usage.reportedCalls === 1 ? "writing.calls.usageOne" : "writing.calls.usage", {
        tokens: usage.totalTokens.toLocaleString(),
        count: String(usage.reportedCalls),
      })}
    </p>
  );
}

export function WritingRetryEstimate({ usage }: { readonly usage: WritingCallUsage | null }) {
  const t = useT();
  if (!usage?.repeatedCalls) return null;
  return (
    <p className="text-xs">
      {t("writing.calls.retryEstimate", {
        tokens: usage.repeatedInputTokens.toLocaleString(),
        count: String(usage.repeatedCalls),
      })}
    </p>
  );
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

export function WritingCallPause({
  pause,
  usage,
}: {
  readonly pause: CallPause;
  readonly usage?: WritingCallUsage | null;
}) {
  const t = useT();
  const button = "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover)";
  return (
    <fieldset className="space-y-2 rounded border border-(--mint-border) p-2 text-sm">
      <legend>{t("writing.calls.paused")}</legend>
      <p role="status">{t("writing.calls.used", { count: String(pause.calls) })}</p>
      <WritingReportedUsage usage={usage} />
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
