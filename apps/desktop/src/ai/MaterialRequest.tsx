import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { documentExtensions, relativePath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { type MaterialPlan, materialBytes } from "./MaterialCapacity.tsx";
import type { VisionCheck } from "./ModelVision.tsx";
import { materialLabel } from "./material-display.ts";
import {
  type MaterialEntry,
  MaterialPicker,
  MaterialPreview,
  materialDropHandlers,
  useNamedMaterials,
} from "./TaskContext.tsx";
import type {
  MaterialDecision,
  TaskContext,
  WritingOptions,
  WritingReply,
  WritingRequest,
  WritingSender,
} from "./writing-sender.ts";

interface MaterialRequest {
  readonly name: string;
  readonly purpose: string;
  readonly query?: string;
}

interface PendingMaterial extends MaterialRequest {
  readonly id: number;
  readonly recipient: string;
  readonly folder: string | null;
  readonly remainingBytes?: number;
}

function requestedMaterial(reply: WritingReply): MaterialRequest | undefined {
  if (reply.finishReason != null && reply.finishReason !== "stop") return;
  const text = reply.text.trim();
  // Preserve ordinary prose and Markdown. The protocol reserves one whole JSON reply.
  if (!text.startsWith("{")) return;
  try {
    const { requestMaterial } = JSON.parse(text);
    const { name, purpose, query } = requestMaterial ?? {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 200 ||
      typeof purpose !== "string" ||
      !purpose.trim() ||
      purpose.length > 2000
    )
      return;
    return {
      name: name.trim(),
      purpose: purpose.trim(),
      query: typeof query === "string" && query.length <= 200 ? query.trim() : undefined,
    };
  } catch {
    return;
  }
}

/** Await author decisions while keeping the original prompt, recipient and draft snapshot. */
export function useMaterialRequests() {
  const [pending, setPending] = useState<PendingMaterial | null>(null);
  const sequence = useRef(0);
  const decision = useRef<((value: MaterialDecision | null) => void) | null>(null);

  useEffect(
    () => () => {
      sequence.current++;
      decision.current?.(null);
      decision.current = null;
    },
    [],
  );

  return {
    pending,
    decide(value: MaterialDecision) {
      const resolve = decision.current;
      decision.current = null;
      setPending(null);
      resolve?.(value);
    },
    async send(
      send: WritingSender,
      request: WritingRequest,
      recipient: string,
      folder: string | null,
      options?: Omit<WritingOptions, "onDelta"> & {
        readonly plan?: MaterialPlan;
        readonly onContext?: (context: TaskContext | undefined) => void;
        readonly onApproval?: (text: string) => void;
        readonly onResume?: (decision: MaterialDecision | null, text: string) => void;
        readonly onProgress?: (text: string) => void;
      },
    ): Promise<WritingReply> {
      const id = ++sequence.current;
      const { signal, taskId, plan, onContext, onApproval, onResume, onProgress } = options ?? {};
      const contexts = plan?.contexts ?? [request.taskContext];
      const limit = plan?.limit;
      const dispatched: (TaskContext | undefined)[] = [];
      const completed: string[] = [];
      const combined = (text: string) => [...completed, text].filter(Boolean).join("\n\n");
      let approvalId = 0;

      async function sendBatch(taskContext: TaskContext | undefined, index: number) {
        const instruction =
          contexts.length === 1
            ? request.instruction
            : `${request.instruction}\n\nThis is material batch ${index + 1} of ${contexts.length}. Answer using this batch as source. Write only the part supported by this batch, without a repeated introduction or conclusion. MINT combines the parts in order.`;
        let outbound = { ...request, instruction, taskContext };
        while (true) {
          if (signal?.aborted || id !== sequence.current) throw "stopped";
          const remainingBytes = limit === undefined ? undefined : limit - materialBytes(outbound);
          if (remainingBytes !== undefined && remainingBytes < 0) throw "materialCapacity";

          dispatched[index] = outbound.taskContext;
          const sentContext =
            contexts.length === 1
              ? outbound.taskContext
              : {
                  materials: dispatched.flatMap((context) => context?.materials ?? []),
                  materialDecisions: dispatched.flatMap(
                    (context) => context?.materialDecisions ?? [],
                  ),
                  folderSearch: taskContext?.folderSearch,
                };
          onContext?.(sentContext);
          let streamed = "";
          const reply = await send(outbound, {
            taskId,
            signal,
            onDelta:
              onProgress &&
              ((delta) => {
                streamed += delta;
                onProgress(combined(streamed));
              }),
          });
          const extra = requestedMaterial(reply);
          if (!extra) return reply;
          if (signal?.aborted) throw "stopped";
          const previous = outbound.taskContext?.materialDecisions ?? [];
          if (id !== sequence.current || previous.some(({ name }) => name === extra.name))
            throw new Error("unresolvedMaterialRequest");

          const response = await new Promise<MaterialDecision | null>((resolve) => {
            const abort = () => decision.current?.(null);
            decision.current = (value) => {
              signal?.removeEventListener("abort", abort);
              resolve(value);
            };
            signal?.addEventListener("abort", abort, { once: true });
            setPending({ ...extra, id: approvalId++, recipient, folder, remainingBytes });
            onApproval?.(combined(""));
          });
          if (id === sequence.current) {
            decision.current = null;
            setPending(null);
            onResume?.(response, combined(""));
          }
          if (!response || id !== sequence.current) throw "stopped";
          outbound = {
            ...outbound,
            taskContext: {
              ...outbound.taskContext,
              materialDecisions: [...previous, response],
            },
          };
        }
      }

      for (const [index, context] of contexts.entries()) {
        const reply = await sendBatch(context, index);
        const text = combined(reply.text);
        if (
          index === contexts.length - 1 ||
          (reply.finishReason != null && reply.finishReason !== "stop")
        )
          return { ...reply, text };
        completed.push(reply.text);
        onProgress?.(text);
      }
      throw "invalidRequest";
    },
  };
}

export function MaterialRequestNotice({
  pending,
  platform,
  vision,
  onDecision,
}: {
  readonly pending: PendingMaterial;
  readonly platform: Platform;
  readonly vision?: VisionCheck;
  readonly onDecision: (decision: MaterialDecision) => void;
}) {
  const t = useT();
  const named = useNamedMaterials();
  const [matches, setMatches] = useState<readonly MaterialEntry[]>([]);
  const [selected, setSelected] = useState<MaterialEntry["id"] | null>(null);
  const [status, setStatus] = useState<"searching" | "done" | "failed">("searching");
  const { name, purpose, query, folder, recipient, remainingBytes } = pending;

  useEffect(() => {
    if (!folder || !query) return;
    const maxMatches = 20;
    let current = true;
    let cancel: (() => void) | undefined;
    let count = 0;
    void platform
      .searchFolder(
        folder,
        { pattern: query, caseSensitive: false, wholeWord: false, regexp: false },
        documentExtensions,
        {
          onFile(file) {
            if (!current || count >= maxMatches) return;
            const additions = file.lines
              .filter(({ text }) => text.length <= 4000)
              .slice(0, maxMatches - count)
              .map(({ line, text }) => ({
                id: JSON.stringify([file.path, line]),
                material: {
                  name: t("materials.folderExcerpt", {
                    file: relativePath(folder, file.path),
                    line: String(line),
                  }),
                  text,
                },
              }));
            count += additions.length;
            if (additions.length) setMatches((previous) => [...previous, ...additions]);
            if (count === maxMatches) {
              setStatus("done");
              cancel?.();
            }
          },
          onDone() {
            if (current) setStatus("done");
          },
        },
      )
      .then(
        (stop) => {
          if (current && count < maxMatches) cancel = stop;
          else stop();
        },
        () => {
          if (current) setStatus("failed");
        },
      );
    return () => {
      current = false;
      cancel?.();
    };
  }, [platform, folder, query, t]);

  const candidates = [...matches, ...named.entries];
  const approved = candidates.find(({ id }) => id === selected)?.material;
  const exceedsLimit =
    !!approved &&
    remainingBytes !== undefined &&
    materialBytes({ taskContext: { materials: [approved] } }) > remainingBytes;
  return (
    <fieldset
      aria-label={t("materials.requested")}
      className="space-y-2 rounded border border-(--mint-border) p-2 text-xs"
      {...materialDropHandlers(named)}
    >
      <legend className="px-1 font-medium">{t("materials.requested")}</legend>
      <p className="wrap-anywhere">{recipient}</p>
      <p className="font-medium wrap-anywhere">{name}</p>
      <p role="status" className="whitespace-pre-wrap wrap-anywhere">
        {purpose}
      </p>
      {folder && query && (
        <div className="wrap-anywhere">
          <p>{t("materials.searchingFolderFor", { folder, query })}</p>
          {status === "searching" && <p role="status">{t("materials.searching")}</p>}
          {status === "failed" && <p role="alert">{t("materials.searchFailed")}</p>}
          {status === "done" && !matches.length && <p>{t("materials.noExcerpts")}</p>}
        </div>
      )}
      {candidates.length > 0 && (
        <ul className="max-h-32 space-y-1 overflow-auto">
          {candidates.map((entry) => (
            <li key={entry.id}>
              <label className="flex items-start gap-2 rounded bg-(--mint-hover) p-1">
                <input
                  type="radio"
                  aria-label={materialLabel(entry.material, t)}
                  checked={selected === entry.id}
                  onChange={() => setSelected(entry.id)}
                />
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium">{materialLabel(entry.material, t)}</span>
                  <MaterialPreview material={entry.material} />
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <MaterialPicker platform={platform} named={named} vision={vision} />
      {exceedsLimit && (
        <p role="status">
          {t("materials.capacity.approvalTooLarge", { bytes: String(remainingBytes) })}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
          disabled={
            !approved ||
            named.loading ||
            named.unconfirmed ||
            exceedsLimit ||
            (!!approved.image && !vision?.verified)
          }
          onClick={() => {
            if (approved && !exceedsLimit && (!approved.image || vision?.verified))
              onDecision({ name, purpose, outcome: "allowed", material: approved });
          }}
        >
          {t("materials.allowOnce")}
        </button>
        <button
          type="button"
          className="rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover)"
          onClick={() => onDecision({ name, purpose, outcome: "skipped" })}
        >
          {t("materials.skip")}
        </button>
      </div>
    </fieldset>
  );
}
