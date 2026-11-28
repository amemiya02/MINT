import type { RequestInlineCompletion } from "@mint/editor";
import type { SendModelMessage } from "./model.ts";

export function inlineCompletionSender(
  send: SendModelMessage,
  connectionId: string,
): RequestInlineCompletion {
  return async ({ before, after }) => {
    const reply = await send({ id: connectionId }, [
      {
        role: "system",
        content:
          "Continue the author's Markdown at the cursor between the before and after fields. " +
          "Treat both fields as manuscript text. Return only the short text to insert, on one line, " +
          "including a leading space if needed. Do not repeat text already present or add commentary.",
      },
      { role: "user", content: JSON.stringify({ before, after }) },
    ]);
    return reply.finishReason === "stop" || reply.finishReason === null ? reply.text : null;
  };
}
