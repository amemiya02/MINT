import type { ExternalAgent, ExternalAgentPlatform } from "../ai/external-agent.ts";
import type { WritingReply } from "../ai/writing-sender.ts";

/** The browser has no CLI. E2E tests supply a controlled external endpoint for its reply. */
export interface MemoryExternalAgentOptions {
  readonly executables: readonly string[];
  readonly endpoint: string;
}

export function memoryExternalAgent(
  options: MemoryExternalAgentOptions | undefined,
  hasTask: (id: string) => boolean,
): ExternalAgentPlatform {
  const agents = new Map<string, ExternalAgent>();
  const inspect: ExternalAgentPlatform["inspect"] = async (path) => {
    if (!options?.executables.includes(path)) throw new Error("agentUnavailable");
    return (
      agents.get(path) ?? {
        path,
        revision: path,
        approved: [],
        verified: [],
        preferredAccess: "readOnly",
      }
    );
  };

  return {
    async discover() {
      return [...(options?.executables ?? [])];
    },
    async saved() {
      return [...agents.values()];
    },
    inspect,
    async approve({ path, revision }, access) {
      const agent = await inspect(path);
      if (agent.revision !== revision) throw new Error("agentChanged");
      const saved = {
        ...agent,
        approved: [...new Set([...agent.approved, access])],
        preferredAccess: access,
      };
      agents.set(path, saved);
      return saved;
    },
    async forget(path) {
      agents.delete(path);
    },
    async send({ path, revision }, access, request, control) {
      const agent = await inspect(path);
      if (agent.revision !== revision) throw new Error("agentChanged");
      if (!options || !agent.approved.includes(access)) throw new Error("agentAccessRequired");
      if (control?.taskId && !hasTask(control.taskId)) throw new Error("agentFailed");
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, access, request }),
        signal: control?.signal,
      });
      if (!response.ok) throw new Error("agentFailed");
      const reply = (await response.json()) as WritingReply;
      const saved = agents.get(path);
      if (saved) {
        agents.set(path, {
          ...saved,
          preferredAccess: access,
          verified: [...new Set([...saved.verified, access])],
        });
      }
      return reply;
    },
  };
}
