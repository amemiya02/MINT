import { outboundWritingPreferences, writingPreferenceInstruction } from "./writing-preferences.ts";
import {
  materialImageLimit,
  materialRequestInstruction,
  outboundTaskContext,
  replacementInstruction,
  sourcePassageInstruction,
  type TaskContext,
  taskImageLimit,
  type WritingOptions,
  type WritingReply,
  type WritingSender,
} from "./writing-sender.ts";

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

export type ModelMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly ModelMessagePart[];
}

interface ModelOptions extends WritingOptions {
  /** Supply credentials for this request only. */
  readonly apiKey?: string;
}

interface ModelReply extends WritingReply {
  readonly streamed: boolean;
  readonly finishReason: string | null;
}

export type ModelTarget = ModelConnection | Pick<SavedModelConnection, "id">;

export type SendModelMessage = (
  connection: ModelTarget,
  messages: readonly ModelMessage[],
  options?: ModelOptions,
) => Promise<ModelReply>;

function modelTaskContext(context: TaskContext | undefined, images: ModelMessagePart[]) {
  let imageBytes = 0;
  return outboundTaskContext(context, (material) => {
    const { image, ...textMaterial } = material;
    if (image === undefined) return textMaterial;
    imageBytes += image.length;
    if (
      material.format !== "image" ||
      !material.range ||
      image.length > materialImageLimit ||
      imageBytes > taskImageLimit ||
      !image.startsWith("data:image/png;base64,")
    )
      throw "invalidRequest";
    images.push({ type: "image_url", image_url: { url: image } });
    const { name, range, format } = material;
    return { name, range, format };
  });
}

/** Bind the model transport for use from the editor and from first-time setup. */
export function modelWritingSender(
  send: SendModelMessage,
  connection: ModelTarget,
  options?: ModelOptions,
): WritingSender<ModelReply> {
  return (
    {
      instruction,
      preferences,
      selectedText,
      annotationBatch,
      taskContext,
      history,
      responseFormat,
      sourcePassages,
    },
    writingOptions,
  ) => {
    const messages: ModelMessage[] = [];
    if (responseFormat === "replacement")
      messages.push({ role: "system", content: replacementInstruction });
    if (taskContext) messages.push({ role: "system", content: materialRequestInstruction });
    if (sourcePassages) messages.push({ role: "system", content: sourcePassageInstruction });
    if (preferences?.length)
      messages.push({ role: "system", content: writingPreferenceInstruction });
    for (const turn of history ?? []) {
      messages.push(
        { role: "user", content: turn.instruction },
        { role: "assistant", content: turn.reply },
      );
    }
    const images: ModelMessagePart[] = [];
    const context = modelTaskContext(taskContext, images);
    const text =
      selectedText === undefined &&
      annotationBatch === undefined &&
      context === undefined &&
      !preferences?.length
        ? instruction
        : JSON.stringify({
            instruction,
            selectedText,
            annotationBatch,
            taskContext: context,
            preferences: outboundWritingPreferences(preferences),
          });
    if (images.length) {
      messages.push({
        role: "system",
        content:
          "Image parts follow the order of Image pixels materials in task context (format image). Each image contains only the named selected range.",
      });
    }
    messages.push({
      role: "user",
      content: images.length ? [{ type: "text", text }, ...images] : text,
    });
    return send(connection, messages, { ...options, ...writingOptions });
  };
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
  signal?: AbortSignal,
) => Promise<void>;

export const modelTimeoutMs = 120_000;
export const modelResponseLimit = 2 * 1024 * 1024;

function isLoopbackHost(host: string) {
  return host === "localhost" || host === "[::1]" || /^127\.(\d+\.){2}\d+$/.test(host);
}

/** A validated endpoint on the author's machine. */
export function isLocalModelEndpoint(endpoint: string) {
  return isLoopbackHost(new URL(endpoint).hostname);
}

export function isLocalModelOffline(endpoint: string | undefined, problem: unknown) {
  return (
    !!endpoint && (problem === "network" || problem === "timeout") && isLocalModelEndpoint(endpoint)
  );
}

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
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
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

function readChoice(value: { choices?: Choice[] } | null): Choice | undefined {
  if (!Array.isArray(value?.choices)) throw "invalidReply";
  return value.choices[0];
}

function readUsage(
  value:
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      }
    | null
    | undefined,
): WritingReply["usage"] {
  const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = value ?? {};
  if (
    typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    typeof output === "number" &&
    Number.isSafeInteger(output) &&
    output >= 0 &&
    typeof total === "number" &&
    Number.isSafeInteger(total) &&
    total === input + output
  ) {
    return { inputTokens: input, totalTokens: total };
  }
}

export function createModelSender(transport: ModelTransport): SendModelMessage {
  return async (connection, messages, options) => {
    if (!messages.length) throw "invalidRequest";
    const onDelta = options?.onDelta;
    const decoder = new TextDecoder();
    let streamed = false;
    let text = "";
    let finishReason: string | null = null;
    let usage: WritingReply["usage"];
    let sawEnd = false;
    let malformed = false;
    let limitReached = false;
    let contextRejected = false;
    let buffer = "";
    let eventData: string[] = [];

    function readEvent() {
      if (!eventData.length) return;
      const payload = eventData.join("\n");
      eventData = [];
      if (sawEnd || malformed || limitReached || contextRejected) return;
      if (payload === "[DONE]") {
        sawEnd = true;
        return;
      }
      try {
        const event = JSON.parse(payload);
        const code = event?.error?.code;
        if (code === "context_length_exceeded") {
          contextRejected = true;
          return;
        }
        if (code === "insufficient_quota" || code === "rate_limit_exceeded") {
          limitReached = true;
          return;
        }
        const choice = readChoice(event);
        usage = readUsage(event?.usage) ?? usage;
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
      if (options?.signal?.aborted) return;
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
      await transport({ connectionId: connection.id, body }, receive, options?.signal);
    } else {
      const url = modelEndpoint(connection.address);
      const model = connection.model.trim();
      if (!model) throw "invalidRequest";
      const apiKey = modelApiKey(options?.apiKey ?? "");
      await transport({ url, apiKey, body: { ...body, model } }, receive, options?.signal);
    }
    if (streamed) {
      if (contextRejected) throw "materialCapacity";
      if (limitReached) throw "limit";
      if (malformed) throw "invalidReply";
      if (!sawEnd && !finishReason) throw "interrupted";
    } else {
      try {
        const response = JSON.parse(buffer);
        const choice = readChoice(response);
        usage = readUsage(response?.usage);
        const content = choice?.message?.content;
        if (typeof content === "string") text = content;
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      } catch {
        throw "invalidReply";
      }
    }
    if (!text.trim()) throw finishReason === "length" ? "limit" : "invalidReply";
    return { text, streamed, finishReason, usage };
  };
}

export function modelApiKey(input: string): string {
  const apiKey = input.trim();
  // A bearer token must fit in one HTTP header.
  if (apiKey && !/^[!-~]+$/.test(apiKey)) throw "invalidKey";
  return apiKey;
}
