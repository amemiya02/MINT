import type { WritingReply, WritingSender } from "./writing-sender.ts";

export interface ModelConnection {
  readonly address: string;
  readonly model: string;
}

export interface SavedModelConnection {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly keySuffix: string | null;
  readonly lifetime: "persistent" | "session";
}

export interface NewModelConnection extends ModelConnection {
  readonly name: string;
  readonly apiKey: string;
  readonly lifetime: SavedModelConnection["lifetime"];
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

interface ModelReply extends WritingReply {
  readonly streamed: boolean;
  readonly finishReason: string | null;
}

type ModelTarget = ModelConnection | Pick<SavedModelConnection, "id">;

export type SendModelMessage = (
  connection: ModelTarget,
  messages: readonly ModelMessage[],
  options?: ModelOptions,
) => Promise<ModelReply>;

/** Reuse the model transport for the same text tasks that external Agents accept. */
export function modelWritingSender(
  send: SendModelMessage,
  connection: ModelTarget,
  options?: ModelOptions,
): WritingSender<ModelReply> {
  return ({ instruction, selectedText }) =>
    send(
      connection,
      [
        {
          role: "user",
          content:
            selectedText === undefined
              ? instruction
              : JSON.stringify({ instruction, selectedText }),
        },
      ],
      options,
    );
}

interface CompletionInput {
  readonly messages: readonly ModelMessage[];
  readonly stream: boolean;
}

export interface ModelRequest {
  readonly url: string;
  readonly apiKey?: string;
  readonly body: CompletionInput & { readonly model: string };
}

type ConnectedModelRequest = {
  readonly connectionId: string;
  readonly body: CompletionInput;
};

export type ModelResponseEvent =
  | { readonly kind: "headers"; readonly contentType: string }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "done" };

type ModelTransport = (
  request: ModelRequest | ConnectedModelRequest,
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
    if (!messages.length) throw "invalidRequest";
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

    const body = { messages, stream: !!onDelta };
    if ("id" in connection) {
      await transport({ connectionId: connection.id, body }, receive);
    } else {
      const url = modelEndpoint(connection.address);
      const model = connection.model.trim();
      if (!model) throw "invalidRequest";
      const apiKey = modelApiKey(options?.apiKey ?? "");
      await transport({ url, apiKey, body: { ...body, model } }, receive);
    }
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

export function modelApiKey(input: string): string {
  const apiKey = input.trim();
  // A bearer token must fit in one HTTP header.
  if (apiKey && !/^[!-~]+$/.test(apiKey)) throw "invalidKey";
  return apiKey;
}
