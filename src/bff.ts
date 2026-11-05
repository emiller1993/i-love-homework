import type { Pool } from "pg";
import type { BacktestInput, WorkflowDefinition } from "./domain.js";
import { listWorkflowVersions } from "./store.js";
import type { createRuntime } from "./runtime.js";

function downloadJson(value: WorkflowDefinition | BacktestInput): string {
  const content = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024)
    throw new RangeError(
      "This export exceeds the 1 MiB import limit. Use a smaller workflow or record a shorter conversation.",
    );
  return content;
}

export async function exportWorkflow(
  pool: Pool,
  workflowVersionId: string,
): Promise<{ filename: string; content: string }> {
  const version = (await listWorkflowVersions(pool)).find(
    (value) => value.id === workflowVersionId,
  );
  if (!version) throw new RangeError("Unknown workflow version");
  return {
    filename: `${version.key}-v${version.version}.json`,
    content: downloadJson(version.definition),
  };
}

export async function exportConversation(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  sandboxId: string,
  conversationId: string,
): Promise<string> {
  const { conversation, now, workflowVersionIds, completions } =
    await runtime.getConversation(sandboxId, conversationId);
  if (conversation.trace.some((entry) => entry.kind === "restarted"))
    throw new RangeError(
      "Conversation export does not support manual restart yet. Record a new conversation in a fresh sandbox.",
    );
  if (
    conversation.trace.some(
      (entry) => entry.kind === "stopped" && entry.text === "Stopped by user",
    )
  )
    throw new RangeError(
      "Conversation export does not support manual Stop yet. Record a new conversation in a fresh sandbox.",
    );
  if (
    conversation.trace.some((entry) => entry.kind === "configuration_changed")
  )
    throw new RangeError(
      "Conversation export does not support workflow changes yet. Record a new conversation in a fresh sandbox.",
    );
  const first = conversation.trace.find((entry) => entry.kind === "input");
  if (!first) throw new RangeError("The conversation has no recorded input");
  const events = new Map(
    conversation.events.map((event) => [event.eventId, event]),
  );
  const entries: { order: number; entry: BacktestInput["timeline"][number] }[] =
    [];
  let cursor = 0;
  for (const [order, trace] of conversation.trace.entries()) {
    if (trace.kind !== "input" && trace.kind !== "duplicate") continue;
    // The synchronous input Update appends events and input traces in the same order.
    const event =
      trace.kind === "input"
        ? conversation.events[cursor++]
        : events.get(trace.text);
    if (!event)
      throw new RangeError("The conversation has incomplete input history");
    entries.push({
      order,
      entry: { at: trace.at - first.at, kind: "event", event },
    });
  }
  if (cursor !== conversation.events.length)
    throw new RangeError("The conversation has incomplete input history");
  for (const recorded of completions) {
    if (
      recorded.completion.error !== undefined &&
      [...recorded.completion.error].length > 1000
    )
      throw new RangeError(
        "An agent error exceeds the 1000-character backtest limit. The full error remains in the execution trace.",
      );
    const invocation = conversation.invocations.find(
      (value) => value.id === recorded.invocationId,
    );
    if (!invocation)
      throw new RangeError(
        "The conversation has incomplete invocation history",
      );
    const order = conversation.trace.findIndex(
      (entry) =>
        (["accepted_result", "obsolete_result"].includes(entry.kind) &&
          entry.text === invocation.id) ||
        (entry.kind === "error" &&
          entry.runId === invocation.runId &&
          ["failed", "timed_out"].includes(invocation.status)),
    );
    const observed = conversation.trace[order];
    if (!observed && recorded.at === null)
      throw new RangeError(
        "This response has no recorded sandbox time. Record a new conversation before exporting.",
      );
    const at = Math.max(observed?.at ?? 0, recorded.at ?? 0) - first.at;
    entries.push({
      order: order < 0 ? conversation.trace.length : order,
      entry: {
        at,
        kind: "completion",
        target: {
          accountId: invocation.accountId,
          contactId: invocation.contactId,
          triggerEventId: invocation.triggerEventId,
          workflowVersionId: invocation.workflowVersionId,
          callKind: invocation.callKind,
          ...(invocation.stepId === undefined
            ? {}
            : { stepId: invocation.stepId }),
          attempt: invocation.attempt,
        },
        completion: recorded.completion,
      },
    });
  }
  const until = now - first.at;
  const timeline = entries
    .sort((a, b) => a.entry.at - b.entry.at || a.order - b.order)
    .map((value) => value.entry);
  if (
    !Number.isSafeInteger(until) ||
    until < 0 ||
    until > 86_400_000 ||
    workflowVersionIds.length > 100 ||
    timeline.length > 1000 ||
    timeline.some(
      (entry) =>
        !Number.isSafeInteger(entry.at) || entry.at < 0 || entry.at > until,
    )
  )
    throw new RangeError(
      "The conversation exceeds the backtest time or event limits",
    );
  return downloadJson({ workflowVersionIds, timeline, until });
}

export async function prepareBacktest(
  pool: Pool,
  input: BacktestInput,
): Promise<BacktestInput> {
  if (!input.timeline.some((entry) => entry.kind === "completion"))
    return input;
  const versions = await listWorkflowVersions(pool);
  const selected = input.workflowVersionIds.map((id) => {
    const version = versions.find((value) => value.id === id);
    if (!version) throw new RangeError("Unknown selected workflow version");
    return version;
  });
  return {
    ...input,
    timeline: input.timeline.map((entry) => {
      if (
        entry.kind === "event" ||
        selected.some(
          (version) => version.id === entry.target.workflowVersionId,
        )
      )
        return entry;
      const source = versions.find(
        (version) => version.id === entry.target.workflowVersionId,
      );
      const candidates =
        entry.target.workflowVersionId === ""
          ? selected
          : selected.filter((version) => version.key === source?.key);
      const version = candidates.length === 1 ? candidates[0] : undefined;
      if (!version)
        throw new RangeError(
          "Recorded agent responses need one selected version of the same workflow. Keep its recorded step IDs.",
        );
      return {
        ...entry,
        target: { ...entry.target, workflowVersionId: version.id },
      };
    }),
  };
}
