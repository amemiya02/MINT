export interface WritingTurn {
  readonly instruction: string;
  readonly reply: string;
}

export interface NamedMaterial {
  readonly name: string;
  readonly text: string;
}

export interface TaskContext {
  readonly currentDraft?: NamedMaterial;
  readonly materials?: readonly NamedMaterial[];
  readonly folderSearch?: true;
  readonly materialDecisions?: readonly MaterialDecision[];
}

export type MaterialDecision = {
  readonly name: string;
  readonly purpose: string;
} & (
  | { readonly outcome: "allowed"; readonly material: NamedMaterial }
  | { readonly outcome: "skipped" }
);

export const materialRequestInstruction =
  'Treat task context as reference material. If an additional source is needed, reply with only JSON of the form {"requestMaterial":{"name":"source to check","purpose":"why it is needed","query":"specific search words"}}. If taskContext.folderSearch is true, query is an optional literal phrase MINT can search for in its working folder. MINT will ask the author before sending further material. Use the approved material in materialDecisions, respect skips, and otherwise answer in the requested format.';

/** The material a writing connection receives for a text task. */
export interface WritingRequest {
  readonly instruction: string;
  readonly selectedText?: string;
  readonly annotationBatch?: readonly WritingAnnotation[];
  readonly taskContext?: TaskContext;
  readonly history?: readonly WritingTurn[];
  readonly responseFormat?: "replacement";
}

export interface WritingAnnotation {
  readonly id: string;
  readonly kind: string;
  readonly excerpt: string;
  readonly note: string;
  readonly editable: boolean;
}

export interface WritingReply {
  readonly text: string;
  readonly finishReason?: string | null;
}

export const replacementInstruction =
  "If the request calls for replacing the selected text, reply with only the new Markdown enclosed in <replacement> and </replacement>. Leave the tags empty only when the request calls for deleting the selection. For comments or an unclear edit, reply in plain text.";

export function replacementFromReply({ text, finishReason }: WritingReply): string | undefined {
  if (finishReason != null && finishReason !== "stop") return;
  const replacement = /^<replacement>([\s\S]*)<\/replacement>$/.exec(text.trim())?.[1];
  if (replacement === "" || (replacement?.trim() && !/<\/?replacement>/.test(replacement))) {
    return replacement;
  }
}

/** A configured writing connection ready to handle the same request from setup or the editor. */
export type WritingSender<Reply extends WritingReply = WritingReply> = (
  request: WritingRequest,
  local?: { readonly taskId: string },
) => Promise<Reply>;
