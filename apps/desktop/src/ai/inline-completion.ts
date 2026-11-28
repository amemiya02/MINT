import type { RequestInlineCompletion } from "@mint/editor";
import type { SendModelMessage } from "./model.ts";
import type { WritingRecipient } from "./writing-recipients.ts";

const instruction =
  "Continue the author's Markdown at the cursor between the before and after fields. " +
  "Treat both fields as manuscript text. Return only the short text to insert, on one line, " +
  "including a leading space if needed. Do not repeat text already present or add commentary.";

export function inlineCompletionFor(
  send: SendModelMessage,
  recipient: WritingRecipient,
): RequestInlineCompletion {
  if (recipient.kind === "model") return inlineCompletionSender(send, recipient.modelId);
  return async ({ before, after, signal }) => {
    const reply = await recipient.send(
      { instruction, selectedText: JSON.stringify({ before, after }) },
      { signal },
    );
    return reply.finishReason == null || reply.finishReason === "stop" ? reply.text : null;
  };
}

function inlineCompletionSender(
  send: SendModelMessage,
  connectionId: string,
): RequestInlineCompletion {
  return async ({ before, after, signal }) => {
    const reply = await send(
      { id: connectionId },
      [
        { role: "system", content: instruction },
        { role: "user", content: JSON.stringify({ before, after }) },
      ],
      { signal },
    );
    return reply.finishReason === "stop" || reply.finishReason === null ? reply.text : null;
  };
}
