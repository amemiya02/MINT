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
      if (response.status === 400 && (await rejectsContext(response))) throw "materialCapacity";
      await response.body?.cancel().catch(() => {});
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

// Some compatible endpoints use HTTP 400 for context-window errors. Match the structured
// code and bound the amount of error data read just as we bound successful replies.
async function rejectsContext(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16 * 1024) return false;
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode())?.error?.code === "context_length_exceeded";
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
