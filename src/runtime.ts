import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  Connection,
  WithStartWorkflowOperation,
  WorkflowNotFoundError,
  ActivityNotFoundError,
  WorkflowUpdateFailedError,
  WorkflowFailedError,
} from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/activity";
import { bundleWorkflowCode, DefaultLogger, Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Pool, PoolClient } from "pg";
import { conversationLimits } from "./domain.js";
import type { conversationWorkflow } from "./conversation.js";
import type {
  ConversationState,
  ConversationLimits,
  InputEvent,
  InputReceipt,
  JsonValue,
  MockCompletion,
  SandboxRecord,
  SandboxSnapshot,
  WorkflowVersion,
} from "./domain.js";
import { createMockActivities } from "./mock-activities.js";
import { createLifecycleActivities } from "./lifecycle.js";
import { validateAgentResult } from "./activities.js";
import {
  createSandbox,
  loadSandbox,
  loadSandboxVersions,
  loadConversations,
  saveConversation,
  setWorkflowEnabled,
} from "./store.js";

let bundle: ReturnType<typeof bundleWorkflowCode> | undefined;

export async function createRuntime(options: {
  pool: Pool;
  mode: SandboxRecord["mode"];
  temporalAddress?: string;
  taskQueue?: string;
  limits?: ConversationLimits;
}) {
  const { pool } = options;
  const limits = { ...(options.limits ?? conversationLimits) };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw new RangeError("Conversation limits must be positive integers");
  const connection = await Connection.connect({
    address:
      options.temporalAddress ??
      process.env.TEMPORAL_ADDRESS ??
      "temporal:7233",
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  const contexts = new Map<
    string,
    Promise<{
      client: Client;
      taskQueue: string;
      env?: TestWorkflowEnvironment;
      worker?: Worker;
      running?: Promise<void>;
      tail: Promise<void>;
    }>
  >();

  async function context(sandbox: SandboxRecord, initialize = false) {
    let existing = contexts.get(sandbox.id);
    if (!existing) {
      if (sandbox.mode === "accelerated" && !initialize)
        throw new RangeError(
          "Accelerated sandbox is no longer running; create a new sandbox",
        );
      existing = (async () => {
        if (sandbox.mode === "normal")
          return {
            client,
            taskQueue:
              options.taskQueue ??
              process.env.TEMPORAL_TASK_QUEUE ??
              "workflow-automation",
            tail: Promise.resolve(),
          };
        // A test clock is global to its environment, so each sandbox owns one.
        const env = await TestWorkflowEnvironment.createTimeSkipping();
        try {
          bundle ??= bundleWorkflowCode({
            workflowsPath: require.resolve("./conversation.js"),
            logger: new DefaultLogger("WARN"),
          });
          const worker = await Worker.create({
            connection: env.nativeConnection,
            namespace: "default",
            taskQueue: sandbox.id,
            workflowBundle: await bundle,
            activities: {
              ...createLifecycleActivities(pool),
              ...createMockActivities(pool),
            },
          });
          const running = worker.run();
          return {
            client: env.client,
            taskQueue: sandbox.id,
            env,
            worker,
            running,
            tail: Promise.resolve(),
          };
        } catch (error) {
          await env.teardown();
          throw error;
        }
      })();
      contexts.set(sandbox.id, existing);
      void existing.catch(() => {
        contexts.delete(sandbox.id);
      });
    }
    return existing;
  }

  async function locked<T>(
    id: string,
    operation: (client: PoolClient, stopped: boolean) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const record = await client.query<{ stopped: boolean }>(
        "SELECT stopped FROM conversations WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!record.rows[0]) throw new RangeError("Unknown conversation");
      const result = await operation(client, record.rows[0].stopped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function isClosing(error: unknown): boolean {
    return (
      error instanceof WorkflowUpdateFailedError &&
      error.cause instanceof ApplicationFailure &&
      error.cause.type === "ConversationClosed"
    );
  }

  async function waitForClose(result: Promise<unknown>) {
    try {
      await result;
    } catch (error) {
      if (!(
        error instanceof WorkflowFailedError ||
        error instanceof WorkflowNotFoundError
      ))
        throw error;
    }
  }

  async function ordered<T>(
    sandboxId: string,
    operation: (
      value: Awaited<ReturnType<typeof context>>,
      sandbox: SandboxRecord,
    ) => Promise<T>,
  ): Promise<T> {
    const sandbox = await loadSandbox(pool, sandboxId);
    const value = await context(sandbox);
    // A clock advance and a user input cannot interleave within one simulation.
    const result = value.tail.then(() => operation(value, sandbox));
    value.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function getSnapshot(sandboxId: string): Promise<SandboxSnapshot> {
    const sandbox = await loadSandbox(pool, sandboxId);
    const value = await context(sandbox);
    const records = await loadConversations(pool, sandboxId);
    const archived = await pool.query<{ snapshot: string }>(
      "SELECT snapshot FROM conversation_history WHERE conversation_id = ANY($1::text[]) AND snapshot IS NOT NULL ORDER BY created_at, temporal_run_id",
      [records.map((record) => record.id)],
    );
    const conversations: ConversationState[] = [];
    for (const record of records) {
      const history = archived.rows
        .map((row): ConversationState => JSON.parse(row.snapshot))
        .filter((state) => state.id === record.id);
      let current: ConversationState | undefined;
      try {
        current = await value.client.workflow
          .getHandle(record.temporalWorkflowId)
          .query<ConversationState>("getSnapshot");
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
      current ??= history.at(-1);
      if (!current) continue;
      const generations = [
        ...history.filter(
          (state) => state.temporalRunId !== current.temporalRunId,
        ),
        current,
      ];
      conversations.push({
        ...current,
        events: generations.flatMap((state) => state.events),
        duplicates: generations.reduce(
          (count, state) => count + state.duplicates,
          0,
        ),
        runs: generations.flatMap((state) => state.runs),
        invocations: generations.flatMap((state) => state.invocations),
        actions: generations.flatMap((state) => state.actions),
        trace: generations.flatMap((state) => state.trace),
      });
    }
    const runs = conversations.flatMap((entry) => entry.runs);
    const invocations = conversations.flatMap((entry) => entry.invocations);
    const completions = await pool.query<{
      invocation_id: string;
      result: JsonValue;
      error: string | null;
    }>(
      "SELECT invocation_id, result, error FROM mock_calls WHERE sandbox_id = $1 AND completed_at IS NOT NULL",
      [sandboxId],
    );
    for (const invocation of invocations) {
      const completed = completions.rows.find(
        (row) => row.invocation_id === invocation.id,
      );
      if (completed && ["obsolete", "timed_out"].includes(invocation.status)) {
        if (completed.error) invocation.error = completed.error;
        else invocation.result = completed.result;
      }
    }
    const actions = conversations.flatMap((entry) => entry.actions);
    return {
      sandbox,
      now: value.env ? await value.env.currentTimeMs() : Date.now(),
      conversations,
      runs,
      invocations,
      actions,
      messages: actions.filter((action) => action.status === "completed"),
      trace: conversations.flatMap((entry) => entry.trace),
      blocked: conversations.every((entry) => entry.blocked),
    };
  }

  async function drain(sandboxId: string): Promise<SandboxSnapshot> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const snapshot = await getSnapshot(sandboxId);
      const pending = snapshot.invocations.filter(
        (invocation) => invocation.status === "pending",
      );
      const registered =
        snapshot.sandbox.mode === "normal" ||
        pending.length === 0 ||
        (
          await pool.query(
            "SELECT invocation_id FROM mock_calls WHERE sandbox_id = $1 AND invocation_id = ANY($2::text[])",
            [sandboxId, pending.map((invocation) => invocation.id)],
          )
        ).rowCount === pending.length;
      // A blocked Workflow may still have an expired timer awaiting processing.
      const future = snapshot.conversations.every(
        (entry) => entry.nextAt === undefined || entry.nextAt > snapshot.now,
      );
      if (snapshot.blocked && registered && future) return snapshot;
      if (Date.now() >= deadline)
        throw new Error("Execution has not reached an observable wait");
      await delay(10);
    }
  }

  const runtime = {
    async createSandbox(
      workflowVersionIds: string[],
      mode = options.mode,
    ): Promise<SandboxRecord> {
      const sandbox = await createSandbox(pool, workflowVersionIds, mode);
      await context(sandbox, true);
      return sandbox;
    },
    getSnapshot,
    drain,
    async getConversation(
      sandboxId: string,
      conversationId: string,
    ): Promise<{
      now: number;
      workflowVersionIds: string[];
      conversation: ConversationState;
      completions: {
        invocationId: string;
        at: number | null;
        completion: MockCompletion;
      }[];
    }> {
      return ordered(sandboxId, async () => {
        const snapshot = await drain(sandboxId);
        const conversation = snapshot.conversations.find(
          (value) => value.id === conversationId,
        );
        if (!conversation)
          throw new RangeError("Unknown conversation in sandbox");
        const result = await pool.query<{
          invocation_id: string;
          completed_clock_at: string | null;
          result: JsonValue;
          error: string | null;
        }>(
          "SELECT invocation_id, completed_clock_at, result, error FROM mock_calls WHERE sandbox_id = $1 AND invocation_id = ANY($2::text[]) AND completed_at IS NOT NULL ORDER BY completed_at, invocation_id",
          [sandboxId, conversation.invocations.map((value) => value.id)],
        );
        return {
          now: snapshot.now,
          workflowVersionIds: snapshot.sandbox.workflowVersionIds,
          conversation,
          completions: [
            ...result.rows.map((row) => ({
              invocationId: row.invocation_id,
              at:
                row.completed_clock_at === null
                  ? null
                  : Number(row.completed_clock_at),
              completion:
                row.error === null
                  ? { result: row.result }
                  : { error: row.error },
            })),
            ...conversation.invocations.flatMap((invocation) => {
              if (
                invocation.completedAt === undefined ||
                result.rows.some((row) => row.invocation_id === invocation.id)
              )
                return [];
              let completion: MockCompletion;
              if (invocation.error !== undefined)
                completion = { error: invocation.error };
              else if (invocation.result !== undefined)
                completion = { result: invocation.result };
              else
                throw new RangeError("The invocation has no recorded outcome");
              return [
                {
                  invocationId: invocation.id,
                  at: invocation.completedAt,
                  completion,
                },
              ];
            }),
          ],
        };
      });
    },
    async acceptEvent(
      sandboxId: string,
      event: InputEvent,
    ): Promise<InputReceipt> {
      return ordered(sandboxId, async (value, sandbox) => {
        if (event.accountId !== sandbox.accountId)
          throw new RangeError("Account does not belong to this sandbox");
        if (event.kind === "comment" && !event.commentId)
          throw new RangeError("Comment events require commentId");
        const id = await saveConversation(pool, sandbox, event.contactId);
        const versions = await loadSandboxVersions(pool, sandboxId);
        for (let attempt = 0; attempt < 2; attempt++) {
          let closingRunId: string | undefined;
          try {
            return await locked<InputReceipt>(id, async (client, stopped) => {
              const duplicate = await client.query(
                "SELECT 1 FROM input_events WHERE conversation_id = $1 AND event_id = $2",
                [id, JSON.stringify(event.eventId)],
              );
              if (duplicate.rowCount)
                return {
                  eventId: event.eventId,
                  conversationId: id,
                  duplicate: true,
                  applied: true,
                };
              if (stopped)
                throw new RangeError(
                  "Conversation history limit reached; explicit restart required",
                );
              const startWorkflowOperation = new WithStartWorkflowOperation<
                typeof conversationWorkflow
              >("conversationWorkflow", {
                workflowId: id,
                taskQueue: value.taskQueue,
                workflowIdConflictPolicy: "USE_EXISTING",
                retry: { maximumAttempts: 1 },
                followRuns: false,
                args: [
                  {
                    id,
                    sandboxId,
                    accountId: sandbox.accountId,
                    contactId: event.contactId,
                    limits,
                  },
                ],
              });
              const update = await value.client.workflow.startUpdateWithStart<
                typeof conversationWorkflow,
                InputReceipt,
                [InputEvent, WorkflowVersion[]]
              >("acceptEvent", {
                waitForStage: "ACCEPTED",
                startWorkflowOperation,
                args: [event, versions],
              });
              closingRunId = update.workflowRunId;
              return update.result();
            });
          } catch (error) {
            if (!isClosing(error) || !closingRunId) throw error;
            // Release the row lock before waiting for the archival Activity to commit.
            await waitForClose(
              value.client.workflow.result(id, closingRunId, {
                followRuns: false,
              }),
            );
          }
        }
        throw new RangeError(
          "Conversation closed while accepting input; retry the event",
        );
      });
    },
    async setWorkflowEnabled(
      sandboxId: string,
      workflowVersionId: string,
      enabled: boolean,
    ): Promise<void> {
      return ordered(sandboxId, async (value) => {
        await setWorkflowEnabled(pool, sandboxId, workflowVersionId, enabled);
        const versions = await loadSandboxVersions(pool, sandboxId);
        for (const record of await loadConversations(pool, sandboxId)) {
          if (record.stopped) continue;
          const handle = value.client.workflow.getHandle(
            record.temporalWorkflowId,
          );
          try {
            if ((await handle.describe()).status.name !== "RUNNING") continue;
            await handle.executeUpdate("setEnabled", { args: [versions] });
          } catch (error) {
            if (!(error instanceof WorkflowNotFoundError) && !isClosing(error))
              throw error;
          }
        }
      });
    },
    async stopConversation(
      sandboxId: string,
      conversationId: string,
    ): Promise<void> {
      return ordered(sandboxId, async (value) => {
        const record = (await loadConversations(pool, sandboxId)).find(
          (entry) => entry.id === conversationId,
        );
        if (!record) throw new RangeError("Unknown conversation in sandbox");
        if (record.stopped)
          throw new RangeError(
            "Conversation history limit reached; explicit restart required",
          );
        const handle = value.client.workflow.getHandle(
          record.temporalWorkflowId,
        );
        try {
          if ((await handle.describe()).status.name !== "RUNNING") return;
          await handle.executeUpdate("stopConversation", { args: [] });
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError) && !isClosing(error))
            throw error;
        }
      });
    },
    async restartConversation(
      sandboxId: string,
      conversationId: string,
    ): Promise<void> {
      return ordered(sandboxId, async (value, sandbox) => {
        const record = (await loadConversations(pool, sandboxId)).find(
          (entry) => entry.id === conversationId,
        );
        if (!record) throw new RangeError("Unknown conversation in sandbox");
        if (!record.stopped)
          throw new RangeError(
            "Conversation is not stopped by its history limit",
          );
        const archived = await pool.query<{ temporal_run_id: string }>(
          "SELECT temporal_run_id FROM conversation_history WHERE conversation_id = $1 AND snapshot IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [record.id],
        );
        if (!archived.rows[0])
          throw new RangeError(
            "Stopped conversation has no archived execution",
          );
        await waitForClose(
          value.client.workflow.result(
            record.temporalWorkflowId,
            archived.rows[0].temporal_run_id,
            { followRuns: false },
          ),
        );
        await locked(record.id, async (client, stopped) => {
          if (!stopped) return;
          await client.query(
            "UPDATE conversations SET stopped = false WHERE id = $1",
            [record.id],
          );
          await value.client.workflow.start("conversationWorkflow", {
            workflowId: record.temporalWorkflowId,
            taskQueue: value.taskQueue,
            workflowIdConflictPolicy: "USE_EXISTING",
            retry: { maximumAttempts: 1 },
            args: [
              {
                id: record.id,
                sandboxId,
                accountId: sandbox.accountId,
                contactId: record.contactId,
                limits,
                restarted: true,
              },
            ],
          });
        });
      });
    },
    async completeInvocation(
      sandboxId: string,
      invocationId: string,
      completion: MockCompletion,
    ): Promise<void> {
      return ordered(sandboxId, async (value, sandbox) => {
        if (sandbox.mode !== "accelerated")
          throw new RangeError(
            "Manual completion requires an accelerated sandbox",
          );
        const invocation = (await getSnapshot(sandboxId)).invocations.find(
          (entry) => entry.id === invocationId,
        );
        if (!invocation) throw new RangeError("Unknown invocation in sandbox");
        if (completion.result !== undefined)
          validateAgentResult(invocation, completion.result);
        const clock = value.env ? await value.env.currentTimeMs() : Date.now();
        const result = await pool.query<{ task_token: Buffer }>(
          `UPDATE mock_calls SET result = $3, error = $4, completed_clock_at = CASE WHEN completed_at IS NULL THEN $5 ELSE completed_clock_at END, completed_at = COALESCE(completed_at, now()) WHERE sandbox_id = $1 AND invocation_id = $2 AND (completed_at IS NULL OR (result IS NOT DISTINCT FROM $3::jsonb AND error IS NOT DISTINCT FROM $4::text)) RETURNING task_token`,
          [
            sandboxId,
            invocationId,
            "result" in completion ? JSON.stringify(completion.result) : null,
            completion.error ?? null,
            clock,
          ],
        );
        if (!result.rows[0])
          throw new RangeError(
            "Invocation is not ready or has a different completion",
          );
        try {
          if (completion.error !== undefined)
            await value.client.activity.fail(
              result.rows[0].task_token,
              ApplicationFailure.nonRetryable(completion.error),
            );
          else
            await value.client.activity.complete(
              result.rows[0].task_token,
              completion.result,
            );
        } catch (error) {
          if (!(error instanceof ActivityNotFoundError)) throw error;
        }
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const current = (await getSnapshot(sandboxId)).invocations.find(
            (entry) => entry.id === invocationId,
          )!;
          if (current.status !== "pending") return;
          await delay(10);
        }
        throw new Error("Completion recorded; Workflow has not applied it yet");
      });
    },
    async advanceTime(
      sandboxId: string,
      milliseconds: number,
      until?: number,
    ): Promise<SandboxSnapshot> {
      return ordered(sandboxId, async (value) => {
        if (!value.env)
          throw new RangeError("Time controls require an accelerated sandbox");
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
          throw new RangeError("Time must be a nonnegative integer");
        let snapshot = await drain(sandboxId);
        const target = until ?? snapshot.now + milliseconds;
        while (snapshot.now < target) {
          const nextAt = Math.min(
            target,
            ...snapshot.conversations.flatMap((entry) =>
              entry.nextAt === undefined ? [] : [entry.nextAt],
            ),
          );
          await value.env.sleep(Math.max(1, nextAt - snapshot.now));
          snapshot = await drain(sandboxId);
        }
        return snapshot;
      });
    },
    async disposeSandbox(sandboxId: string): Promise<void> {
      const value = await contexts.get(sandboxId);
      if (!value) return;
      await value.tail;
      if (value.worker) value.worker.shutdown();
      if (value.running) await value.running;
      if (value.env) await value.env.teardown();
      contexts.delete(sandboxId);
    },
    async close(): Promise<void> {
      try {
        for (const id of contexts.keys()) await runtime.disposeSandbox(id);
      } finally {
        await connection.close();
      }
    },
  };
  return runtime;
}
