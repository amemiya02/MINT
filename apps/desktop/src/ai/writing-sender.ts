export interface WritingTurn {
  readonly instruction: string;
  readonly reply: string;
}

/** The material a writing connection receives for a text task. */
export interface WritingRequest {
  readonly instruction: string;
  readonly selectedText?: string;
  readonly history?: readonly WritingTurn[];
  readonly responseFormat?: "replacement";
}

export interface WritingReply {
  readonly text: string;
  readonly finishReason?: string | null;
}

export const replacementInstruction =
  "If the request calls for replacing the selected text, reply with only the new Markdown enclosed in <replacement> and </replacement>. For comments or an unclear edit, reply in plain text.";

export function replacementFromReply({ text, finishReason }: WritingReply): string | undefined {
  if (finishReason && finishReason !== "stop") return;
  const replacement = /^<replacement>([\s\S]+)<\/replacement>$/.exec(text.trim())?.[1];
  if (replacement?.trim() && !/<\/?replacement>/.test(replacement)) return replacement;
}

/** A configured writing connection ready to handle the same request from setup or the editor. */
export type WritingSender<Reply extends WritingReply = WritingReply> = (
  request: WritingRequest,
) => Promise<Reply>;
