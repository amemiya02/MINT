import type { Platform } from "../platform/platform.ts";
import { type AgentAccess, externalAgentSender } from "./external-agent.ts";
import { modelEndpoint, modelWritingSender } from "./model.ts";
import type { WritingSender } from "./writing-sender.ts";

export type WritingRecipient = {
  readonly id: string;
  readonly send: WritingSender;
} & (
  | { readonly kind: "agent"; readonly path: string; readonly access: AgentAccess }
  | { readonly kind: "model"; readonly modelId: string; readonly name: string; readonly endpoint: string }
);

/** Bind native-approved Agent policies and saved model IDs to the shared text sender. */
export async function loadWritingRecipients(platform: Platform, agentAccess?: AgentAccess) {
  const [agents, models] = await Promise.allSettled([
    platform.externalAgent.saved(),
    platform.listModelConnections(),
  ]);
  const available: WritingRecipient[] = [];
  let failed = agents.status === "rejected" || models.status === "rejected";
  if (agents.status === "fulfilled") {
    for (const agent of agents.value) {
      const access = agentAccess ?? agent.preferredAccess;
      if (!agent.approved.includes(access)) continue;
      available.push({
        id: `agent:${JSON.stringify([agent.path, agent.revision, access])}`,
        kind: "agent",
        path: agent.path,
        access,
        send: externalAgentSender(platform.externalAgent, agent, access),
      });
    }
  }
  if (models.status === "fulfilled") {
    for (const model of models.value) {
      try {
        available.push({
          id: `model:${model.id}`,
          kind: "model",
          modelId: model.id,
          name: model.name,
          endpoint: modelEndpoint(model.address),
          send: modelWritingSender(platform.sendModelMessage, { id: model.id }),
        });
      } catch {
        failed = true;
      }
    }
  }
  return { available, failed };
}
