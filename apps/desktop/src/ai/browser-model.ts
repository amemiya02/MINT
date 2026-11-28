import {
  type ModelRequest,
  type ModelResponseEvent,
  modelResponseLimit,
  modelTimeoutMs,
} from "./model.ts";

export async function sendBrowserModelRequest(
  { url, apiKey, body }: ModelRequest,
  receive: (event: ModelResponseEvent) => void,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(modelTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw response.status;
    }
    receive({ kind: "headers", contentType: response.headers.get("content-type") ?? "" });
    const reader = response.body?.getReader();
    if (!reader) throw "invalidReply";
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > modelResponseLimit) throw "invalidReply";
        receive({ kind: "data", bytes: next.value });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    receive({ kind: "done" });
  } catch (error) {
    if (signal?.aborted) throw "stopped";
    if (typeof error === "number" || typeof error === "string") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw "timeout";
    throw "network";
  }
}
