import type { AppliedWritingPreference } from "./writing-preferences.ts";

export interface WritingTurn {
  readonly instruction: string;
  readonly reply: string;
}

export interface NamedMaterial {
  readonly name: string;
  readonly text: string;
  readonly range?: MaterialRange;
  readonly format?: "extractedText" | "caption" | "image" | "summary";
  /** A locally prepared PNG of the selected range. The original file is never part of a request. */
  readonly image?: string;
  /** Private provenance for rereading a working-folder excerpt. */
  readonly sourceFile?: { readonly path: string; readonly line: number };
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

/** Transform the materials at the outgoing boundary and omit local provenance. */
export function outboundTaskContext<Material>(
  context: TaskContext | undefined,
  transform: (material: Omit<NamedMaterial, "sourceFile">) => Material,
) {
  if (!context) return;
  const outbound = ({ sourceFile: _sourceFile, ...material }: NamedMaterial) => transform(material);
  return {
    ...context,
    currentDraft: context.currentDraft && outbound(context.currentDraft),
    materials: context.materials?.map(outbound),
    materialDecisions: context.materialDecisions?.map((decision) =>
      decision.outcome === "allowed"
        ? { ...decision, material: outbound(decision.material) }
        : decision,
    ),
  };
}

export function hasTaskImages(...contexts: readonly (TaskContext | undefined)[]): boolean {
  return contexts.some((context) => contextMaterials(context).some(({ image }) => !!image));
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

const sourcePassageFrameInstruction =
  '<source-passages> block containing a JSON array, then </source-passages> on its own line. Each entry has {"claim":"exact complete sentence from the Markdown including punctuation","material":1,"quote":"exact contiguous excerpt from that material"}. Number taskContext.materials starting at 1, then count allowed materialDecisions in order. Give entries only for sentences supported by those excerpts and include enough surrounding words to identify a unique occurrence in the material. Use [] when no sentence can be supported. Keep source markers out of the Markdown. If requesting additional material, use the separate material request format instead.';

export const sourcePassageInstruction = `For a draft based on task materials, return the Markdown first, then append a blank line and a ${sourcePassageFrameInstruction}`;

export const taskCopySourcePassageInstruction = `For a draft based on task materials, write the Markdown to the task copy and return only a ${sourcePassageFrameInstruction}`;

/** The material a writing connection receives for a text task. */
export interface WritingRequest {
  readonly instruction: string;
  readonly preferences?: readonly AppliedWritingPreference[];
  readonly selectedText?: string;
  readonly annotationBatch?: readonly WritingAnnotation[];
  readonly taskContext?: TaskContext;
  readonly history?: readonly WritingTurn[];
  readonly responseFormat?: "replacement" | "draft";
  readonly sourcePassages?: true;
  readonly folderDocuments?: readonly TaskCopyDocument[];
}

export interface TaskCopyDocument {
  readonly path: string;
  readonly text: string;
}

export interface TaskCopyChange extends TaskCopyDocument {
  readonly from?: string;
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
  readonly taskCopy?: string | null;
  readonly ignoredChanges?: boolean;
  readonly fileChanges?: readonly TaskCopyChange[];
  readonly finishReason?: string | null;
  readonly usage?: { readonly inputTokens: number; readonly totalTokens: number };
}

export const replacementInstruction =
  "If the request calls for replacing the selected text, reply with only the new Markdown enclosed in <replacement> and </replacement>. Leave the tags empty only when the request calls for deleting the selection. For comments or an unclear edit, reply in plain text.";

export function replacementFromReply({
  text,
  taskCopy,
  finishReason,
}: WritingReply): string | undefined {
  if (finishReason != null && finishReason !== "stop") return;
  if (taskCopy !== undefined) return taskCopy ?? undefined;
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
