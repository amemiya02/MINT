import type { Translate } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";
import { type AgentAccess, type ExternalAgent, externalAgentSender } from "./external-agent.ts";
import { modelEndpoint, modelWritingSender, type SavedModelConnection } from "./model.ts";
import type { WritingSender } from "./writing-sender.ts";

export type WritingRecipient = {
  readonly id: string;
  readonly send: WritingSender;
} & (
  | { readonly kind: "agent"; readonly path: string; readonly access: AgentAccess }
  | {
      readonly kind: "model";
      readonly modelId: string;
      readonly name: string;
      readonly endpoint: string;
    }
);

export type WritingConnectionSetting =
  | "defaultWritingConnection"
  | "inlineCompletionModel"
  | "reviewWritingConnection"
  | "multiFileWritingConnection";

export const useDefaultConnection = "default";

export function writingConnectionChoice(settings: Settings, setting: WritingConnectionSetting) {
  const choice = settings[setting];
  if (setting === "inlineCompletionModel" && choice !== useDefaultConnection) return choice;
  return choice || settings.defaultWritingConnection;
}

/** Settings survive changes to an Agent's approval revision; each send still uses the live approval. */
export function writingConnectionId(recipient: WritingRecipient) {
  return recipient.kind === "agent" ? `agent:${recipient.path}` : recipient.id;
}

export function effectiveWritingRecipient(available: readonly WritingRecipient[], choice: string) {
  if (!choice) return available[0];
  return available.find(
    (item) =>
      writingConnectionId(item) === choice || (item.kind === "model" && item.modelId === choice),
  );
}

export function writingRecipientLabel(t: Translate, recipient: WritingRecipient) {
  return recipient.kind === "agent"
    ? t("writing.recipient.agent", { path: recipient.path })
    : t("writing.recipient.model", { name: recipient.name, endpoint: recipient.endpoint });
}

/** Bind native-approved Agent policies and saved model IDs to the shared text sender. */
export function writingRecipients(
  platform: Platform,
  models: readonly SavedModelConnection[],
  agents: readonly ExternalAgent[],
  agentAccess?: AgentAccess,
) {
  const available: WritingRecipient[] = [];
  let failed = false;
  for (const agent of agents) {
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
  for (const model of models) {
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
  return { available, failed };
}

export async function loadWritingRecipients(platform: Platform, agentAccess?: AgentAccess) {
  const [agents, models] = await Promise.allSettled([
    platform.externalAgent.saved(),
    platform.listModelConnections(),
  ]);
  const { available, failed } = writingRecipients(
    platform,
    models.status === "fulfilled" ? models.value : [],
    agents.status === "fulfilled" ? agents.value : [],
    agentAccess,
  );
  return {
    available,
    failed: failed || agents.status === "rejected" || models.status === "rejected",
  };
}
