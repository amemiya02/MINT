import { createModelSender, modelResponseLimit, modelTimeoutMs } from "./model.ts";

export const sendBrowserModelMessage = createModelSender(async ({ url, apiKey, body }, receive) => {
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
      signal: AbortSignal.timeout(modelTimeoutMs),
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
      await reader.cancel();
    }
    receive({ kind: "done" });
  } catch (error) {
    if (typeof error === "number" || typeof error === "string") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw "timeout";
    throw "network";
  }
});
