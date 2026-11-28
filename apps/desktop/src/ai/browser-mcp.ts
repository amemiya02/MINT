import { type McpTransport, mcpEventResponse, mcpIsEventStream, mcpResponseLimit } from "./mcp.ts";

export const sendBrowserMcpRequest: McpTransport = async (request, signal) => {
  const { endpoint, method, body, session, version } = request;
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(endpoint, {
    method,
    headers: {
      accept: "application/json, text/event-stream",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(session ? { "mcp-session-id": session } : {}),
      ...(version ? { "mcp-protocol-version": version } : {}),
    },
    body: body && JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let scanned = 0;
  const contentType = response.headers.get("content-type") ?? undefined;
  const eventStream = mcpIsEventStream(contentType);
  const boundary = /\r?\n\r?\n/g;
  try {
    if (!response.ok) throw "mcpFailed";
    if (reader && request.responseId !== undefined) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > mcpResponseLimit) throw "mcpFailed";
        text += decoder.decode(chunk.value, { stream: true });
        if (eventStream) {
          boundary.lastIndex = scanned;
          let match = boundary.exec(text);
          while (match) {
            const event = mcpEventResponse(text.slice(scanned, match.index), request.responseId);
            scanned = boundary.lastIndex;
            if (event) {
              text = text.slice(0, scanned);
              break;
            }
            match = boundary.exec(text);
          }
          if (match) break;
        }
      }
      text += decoder.decode();
    }
  } finally {
    void reader?.cancel().catch(() => {});
  }
  return {
    body: text,
    session: response.headers.get("mcp-session-id") ?? undefined,
    contentType,
  };
};
