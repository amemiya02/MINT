import {
  outboundWritingPreferences,
  type WritingPreference,
  writingPreferenceInstruction,
} from "./writing-preferences.ts";
import {
  hasTaskImages,
  materialRequestInstruction,
  outboundTaskContext,
  replacementInstruction,
  sourcePassageInstruction,
  taskCopySourcePassageInstruction,
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
    request: Omit<WritingRequest, "responseFormat" | "sourcePassages" | "preferences"> & {
      readonly preferences?: readonly WritingPreference[];
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
    if (request.folderDocuments && access !== "taskCopy") throw "invalidRequest";
    if (hasTaskImages(request.taskContext)) throw "invalidRequest";
    const instruction = [request.instruction];
    if (request.preferences?.length) instruction.push(writingPreferenceInstruction);
    const taskCopy =
      access === "taskCopy" && responseFormat
        ? responseFormat === "replacement"
          ? "edit"
          : "draft"
        : undefined;
    if (responseFormat === "replacement" && !taskCopy) instruction.push(replacementInstruction);
    if (request.taskContext) instruction.push(materialRequestInstruction);
    if (sourcePassages)
      instruction.push(taskCopy ? taskCopySourcePassageInstruction : sourcePassageInstruction);
    const reply = await platform.send(
      agent,
      access,
      {
        ...request,
        preferences: outboundWritingPreferences(request.preferences),
        taskContext: outboundTaskContext(request.taskContext, (material) => material),
        taskCopy,
        instruction: instruction.join("\n\n"),
      },
      options,
    );
    return taskCopy ? { ...reply, taskCopy: reply.taskCopy ?? null } : reply;
  };
}
