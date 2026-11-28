export interface WritingTurn {
  readonly instruction: string;
  readonly reply: string;
}

export interface NamedMaterial {
  readonly name: string;
  readonly text: string;
  readonly range?: MaterialRange;
  readonly format?: "extractedText" | "caption" | "image";
  /** A locally prepared PNG of the selected range. The original file is never part of a request. */
  readonly image?: string;
}

export interface ImageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MaterialRange =
  | { readonly kind: "pdf"; readonly page: number; readonly pages: number }
  | ({ readonly kind: "image" } & ImageRegion);

export const materialImageLimit = 4 * 1024 * 1024;
export const taskImageLimit = 12 * 1024 * 1024;

export interface TaskContext {
  readonly currentDraft?: NamedMaterial;
  readonly materials?: readonly NamedMaterial[];
  readonly folderSearch?: true;
  readonly materialDecisions?: readonly MaterialDecision[];
}

export function contextMaterials(context?: TaskContext): NamedMaterial[] {
  return [
    ...(context?.currentDraft ? [context.currentDraft] : []),
    ...(context?.materials ?? []),
    ...(context?.materialDecisions ?? []).flatMap((decision) =>
      decision.outcome === "allowed" ? [decision.material] : [],
    ),
  ];
}

export function hasTaskImages(context?: TaskContext): boolean {
  return contextMaterials(context).some(({ image }) => !!image);
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
export interface WritingOptions {
  readonly taskId?: string;
  readonly signal?: AbortSignal;
  readonly onDelta?: (text: string) => void;
}

export type WritingSender<Reply extends WritingReply = WritingReply> = (
  request: WritingRequest,
  options?: WritingOptions,
) => Promise<Reply>;

/** An interrupted edit is reviewable only when the opening replacement was fully framed. */
export function splitWritingProgress(text: string, editing: boolean) {
  const frame = editing ? /^\s*(<replacement>[\s\S]*?<\/replacement>)/.exec(text) : null;
  const replacement = frame ? replacementFromReply({ text: frame[1] ?? "" }) : undefined;
  return replacement === undefined
    ? { partial: text }
    : { replacement, partial: text.slice(frame?.[0].length) };
}
