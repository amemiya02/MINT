export interface ModelConnection {
  readonly address: string;
  readonly model: string;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface ModelOptions {
  /** Supply credentials for this request only. */
  readonly apiKey?: string;
  readonly onDelta?: (text: string) => void;
}

interface ModelReply {
  readonly text: string;
  readonly streamed: boolean;
  readonly finishReason: string | null;
}

export type SendModelMessage = (
  connection: ModelConnection,
  messages: readonly ModelMessage[],
  options?: ModelOptions,
) => Promise<ModelReply>;

export interface ModelRequest {
  readonly url: string;
  readonly apiKey?: string;
  readonly body: {
    readonly model: string;
    readonly messages: readonly ModelMessage[];
    readonly stream: boolean;
  };
}

export type ModelResponseEvent =
  | { readonly kind: "headers"; readonly contentType: string }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "done" };

type ModelTransport = (
  request: ModelRequest,
  receive: (event: ModelResponseEvent) => void,
) => Promise<void>;

export const modelTimeoutMs = 120_000;
export const modelResponseLimit = 2 * 1024 * 1024;

export function modelEndpoint(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw "invalidAddress";
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" ||
          url.hostname === "[::1]" ||
          /^127\.(\d+\.){2}\d+$/.test(url.hostname))
      ))
  ) {
    throw "invalidAddress";
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return url.href;
}

interface Choice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

function readChoice(payload: string): Choice | undefined {
  const value = JSON.parse(payload);
  if (!Array.isArray(value?.choices)) throw "invalidReply";
  return value.choices[0];
}

export function createModelSender(transport: ModelTransport): SendModelMessage {
  return async (connection, messages, options) => {
    const url = modelEndpoint(connection.address);
    const model = connection.model.trim();
    if (!model || !messages.length) throw "invalidRequest";
    const apiKey = options?.apiKey?.trim();
    // A bearer token must fit in one HTTP header.
    if (apiKey && !/^[!-~]+$/.test(apiKey)) throw "invalidKey";
    const onDelta = options?.onDelta;
    const decoder = new TextDecoder();
    let streamed = false;
    let text = "";
    let finishReason: string | null = null;
    let sawEnd = false;
    let malformed = false;
    let buffer = "";
    let eventData: string[] = [];

    function readEvent() {
      if (!eventData.length || sawEnd || malformed) return;
      const payload = eventData.join("\n");
      eventData = [];
      if (payload === "[DONE]") {
        sawEnd = true;
        return;
      }
      try {
        const choice = readChoice(payload);
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
          onDelta?.(delta);
        }
      } catch {
        malformed = true;
      }
    }

    function receive(event: ModelResponseEvent) {
      switch (event.kind) {
        case "headers":
          streamed = event.contentType.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
          break;
        case "data": {
          buffer += decoder.decode(event.bytes, { stream: true });
          if (!streamed) break;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (line === "") readEvent();
            if (line.startsWith("data:")) eventData.push(line.slice(5).replace(/^ /, ""));
            newline = buffer.indexOf("\n");
          }
          break;
        }
        case "done":
          buffer += decoder.decode();
          break;
      }
    }

    await transport({ url, apiKey, body: { model, messages, stream: !!onDelta } }, receive);
    if (streamed) {
      if (malformed) throw "invalidReply";
      if (!sawEnd && !finishReason) throw "interrupted";
    } else {
      try {
        const choice = readChoice(buffer);
        const content = choice?.message?.content;
        if (typeof content === "string") text = content;
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      } catch {
        throw "invalidReply";
      }
    }
    if (!text.trim()) throw "invalidReply";
    return { text, streamed, finishReason };
  };
}
