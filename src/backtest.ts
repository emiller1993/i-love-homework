import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BacktestInput, BacktestReport } from "./domain.js";
import type { createRuntime } from "./runtime.js";

export async function runBacktest(
  input: BacktestInput,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  pool: Pool,
): Promise<BacktestReport> {
  if (!Number.isSafeInteger(input.until) || input.until < 0)
    throw new RangeError("until must be a nonnegative integer");
  let previous = 0;
  for (const entry of input.timeline) {
    if (
      !Number.isSafeInteger(entry.at) ||
      entry.at < previous ||
      entry.at > input.until
    )
      throw new RangeError("Timeline must be ordered and within until");
    previous = entry.at;
  }
  const sandbox = await runtime.createSandbox(
    input.workflowVersionIds,
    "accelerated",
  );
  try {
    const start = (await runtime.getSnapshot(sandbox.id)).now;
    let at = 0;
    for (const entry of input.timeline) {
      await runtime.advanceTime(sandbox.id, entry.at - at, start + entry.at);
      at = entry.at;
      if (entry.kind === "event")
        await runtime.acceptEvent(sandbox.id, entry.event);
      else {
        const snapshot = await runtime.drain(sandbox.id);
        const invocation = snapshot.invocations.find((value) =>
          Object.entries(entry.target).every(
            ([key, expected]) =>
              value[key as keyof typeof entry.target] === expected,
          ),
        );
        if (!invocation)
          throw new RangeError(
            "Completion target does not exist at this timeline position",
          );
        await runtime.completeInvocation(
          sandbox.id,
          invocation.id,
          entry.completion,
        );
      }
      await runtime.drain(sandbox.id);
    }
    const snapshot = await runtime.advanceTime(
      sandbox.id,
      input.until - at,
      start + input.until,
    );
    const report: BacktestReport = {
      id: randomUUID(),
      events: snapshot.conversations.reduce(
        (count, value) => count + value.events.length,
        0,
      ),
      duplicates: snapshot.conversations.reduce(
        (count, value) => count + value.duplicates,
        0,
      ),
      runs: snapshot.runs,
      actions: snapshot.actions,
      messages: snapshot.messages,
      completed: snapshot.runs.filter((run) => run.status === "completed")
        .length,
      stopped: snapshot.runs.filter((run) => run.status === "stopped").length,
      timedOut: snapshot.runs.filter((run) => run.status === "timed_out")
        .length,
      errors: snapshot.runs.flatMap((run) =>
        run.error === undefined ? [] : [run.error],
      ),
      trace: snapshot.trace.map((entry) => ({
        ...entry,
        at: entry.at - start,
      })),
    };
    // Save the observable outcome before destroying the isolated Temporal history.
    await pool.query(
      "INSERT INTO backtests (id, account_id, input, report) VALUES ($1, 'demo-account', $2, $3)",
      [report.id, input, report],
    );
    return report;
  } finally {
    await runtime.disposeSandbox(sandbox.id);
  }
}
