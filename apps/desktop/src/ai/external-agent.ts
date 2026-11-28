import {
  replacementInstruction,
  type WritingReply,
  type WritingRequest,
  type WritingSender,
} from "./writing-sender.ts";

export type AgentAccess = "readOnly" | "configured";

export interface ExternalAgent {
  readonly path: string;
  /** Changes when the executable or the MINT permission policy changes. */
  readonly revision: string;
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
    request: Omit<WritingRequest, "responseFormat">,
  ): Promise<WritingReply>;
}

export function externalAgentSender(
  platform: ExternalAgentPlatform,
  agent: ExternalAgent,
  access: AgentAccess,
): WritingSender {
  // The native boundary rechecks access and executable identity for every operation.
  return ({ responseFormat, ...request }) =>
    platform.send(
      agent,
      access,
      responseFormat === "replacement"
        ? { ...request, instruction: `${request.instruction}\n\n${replacementInstruction}` }
        : request,
    );
}
