import type { WritingReply } from "./writing-sender.ts";

export type AttemptStatus = "working" | "approval" | "complete" | "stopped" | "interrupted" | "limit" | "failed";

export function replyStatus(reply: WritingReply): AttemptStatus {
  if (reply.finishReason === "length") return "limit";
  return reply.finishReason == null || reply.finishReason === "stop" ? "complete" : "interrupted";
}

export function failureStatus(problem: unknown, signal: AbortSignal): AttemptStatus {
  if (signal.aborted) return "stopped";
  const code = problem instanceof Error ? problem.message : problem;
  if (code === 402 || code === 429 || code === "limit") return "limit";
  return code === "network" || code === "timeout" || code === "interrupted"
    ? "interrupted"
    : "failed";
}
