import { activityInfo, cancellationSignal } from "@temporalio/activity";
import { validateAgentResult, type Activities } from "./activities.js";

export function createHttpActivities(baseUrl: string): Activities {
  async function post(path: string, input: unknown): Promise<unknown> {
    const info = activityInfo();
    const remaining =
      info.scheduleToCloseTimeoutMs > 0
        ? info.scheduledTimestampMs + info.scheduleToCloseTimeoutMs - Date.now()
        : info.startToCloseTimeoutMs;
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.any([
        cancellationSignal(),
        // Temporal owns the deadline; abort transport after it records a timeout.
        AbortSignal.timeout(
          Math.max(0, Math.min(info.startToCloseTimeoutMs, remaining)) + 1000,
        ),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`External API ${path}: HTTP ${response.status}`);
    }
    return response.json();
  }
  return {
    async executeAgent(input) {
      const reply = await post("/agent", input);
      if (
        reply === null ||
        typeof reply !== "object" ||
        Array.isArray(reply) ||
        !("result" in reply)
      )
        throw new Error("External API returned an invalid agent response");
      return validateAgentResult(input.invocation, reply.result);
    },
    async sendMessage(action) {
      if (action.channel === "comment" && !action.commentId)
        throw new RangeError("Comment replies require commentId");
      const receipt = await post("/messages", action);
      if (
        receipt === null ||
        typeof receipt !== "object" ||
        Array.isArray(receipt) ||
        !("id" in receipt) ||
        receipt.id !== action.id
      )
        throw new Error("External API returned an invalid send receipt");
      return { ...action, status: "completed" };
    },
  };
}
