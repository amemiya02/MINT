import {
  hasTaskImages,
  materialRequestInstruction,
  replacementInstruction,
  sourcePassageInstruction,
  type WritingOptions,
  type WritingReply,
  type WritingRequest,
  type WritingSender,
} from "./writing-sender.ts";

export type AgentAccess = "readOnly" | "taskCopy" | "configured";

export interface ExternalAgent {
  readonly path: string;
  /** Changes when the executable or the MINT permission policy changes. */
  readonly revision: string;
  readonly supportsTaskCopy?: boolean;
  readonly approved: readonly AgentAccess[];
  readonly verified: readonly AgentAccess[];
  readonly preferredAccess: AgentAccess;
}

/** Only the native platform can inspect and launch the author's installed Agent. */
export interface ExternalAgentPlatform {
  discover(): Promise<string[]>;
  saved(): Promise<ExternalAgent[]>;
  inspect(path: string): Promise<ExternalAgent>;
  approve(agent: ExternalAgent, access: AgentAccess): Promise<ExternalAgent>;
  forget(path: string): Promise<void>;
  send(
    agent: ExternalAgent,
    access: AgentAccess,
    request: Omit<WritingRequest, "responseFormat" | "sourcePassages"> & {
      readonly taskCopy?: "edit" | "draft";
    },
    options?: WritingOptions,
  ): Promise<WritingReply>;
}

export function externalAgentSender(
  platform: ExternalAgentPlatform,
  agent: ExternalAgent,
  access: AgentAccess,
): WritingSender {
  // The native boundary rechecks access and executable identity for every operation.
  return async ({ responseFormat, sourcePassages, ...request }, options) => {
    if (hasTaskImages(request.taskContext)) throw "invalidRequest";
    const instruction = [request.instruction];
    const taskCopy =
      access === "taskCopy" && responseFormat
        ? responseFormat === "replacement"
          ? "edit"
          : "draft"
        : undefined;
    if (responseFormat === "replacement" && !taskCopy) instruction.push(replacementInstruction);
    if (request.taskContext) instruction.push(materialRequestInstruction);
    if (sourcePassages) {
      instruction.push(
        taskCopy
          ? sourcePassageInstruction.replace(
              "return the Markdown first, then append a blank line and a",
              "write the Markdown to the task copy and return only a",
            )
          : sourcePassageInstruction,
      );
    }
    const reply = await platform.send(
      agent,
      access,
      { ...request, taskCopy, instruction: instruction.join("\n\n") },
      options,
    );
    if (taskCopy === "draft" && reply.taskCopy != null) {
      const passages = reply.text.trimStart().startsWith("<source-passages>") ? reply.text : "";
      return { ...reply, text: [reply.taskCopy, passages].filter(Boolean).join("\n\n") };
    }
    return taskCopy ? { ...reply, taskCopy: reply.taskCopy ?? null } : reply;
  };
}
