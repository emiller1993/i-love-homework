import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  bundleWorkflowCode,
  Worker,
  Runtime,
  DefaultLogger,
} from "@temporalio/worker";
import { test as base, expect } from "@playwright/test";
import { createFakeApi } from "../src/fake-api.js";
import { parseWorkflowFile } from "../src/definition.js";
import { createMockActivities } from "../src/mock-activities.js";
import { createLifecycleActivities } from "../src/lifecycle.js";
import { createSandbox, saveConversation } from "../src/store.js";
import type {
  ActionRecord,
  ConversationState,
  InputEvent,
  WorkflowVersion,
} from "../src/domain.js";
import { createRuntime } from "../src/runtime.js";

Runtime.install({ logger: new DefaultLogger("WARN") });
let bundle: ReturnType<typeof bundleWorkflowCode> | undefined;

export function startNormalWorker(taskQueue: string, externalApiUrl?: string) {
  const child = spawn(process.execPath, ["dist/src/worker.js"], {
    env: {
      ...process.env,
      TEMPORAL_TASK_QUEUE: taskQueue,
      ...(externalApiUrl ? { EXTERNAL_API_URL: externalApiUrl } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  return {
    logs: () => logs,
    async stop(force = false) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill(force ? "SIGKILL" : "SIGTERM");
      await exited;
    },
  };
}

export function workflowFixture(key: string): WorkflowVersion {
  return {
    id: key,
    key,
    version: 1,
    definition: parseWorkflowFile(
      readFileSync(`fixtures/${key}.yaml`, "utf8"),
      "yaml",
    ),
  };
}

export async function createConversationHarness(
  sendMessage?: (action: ActionRecord) => Promise<ActionRecord>,
) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sandbox = await createSandbox(pool, [], "accelerated");
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle ??= bundleWorkflowCode({
    workflowsPath: require.resolve("../dist/src/conversation.js"),
    logger: new DefaultLogger("WARN"),
  });
  const activities = createMockActivities(pool);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: "default",
    taskQueue: sandbox.id,
    workflowBundle: await bundle,
    activities: {
      ...createLifecycleActivities(pool),
      ...activities,
      ...(sendMessage ? { sendMessage } : {}),
    },
  });
  const running = worker.run();
  const id = await saveConversation(pool, sandbox, "contact");
  const handle = await env.client.workflow.start("conversationWorkflow", {
    workflowId: id,
    taskQueue: sandbox.id,
    args: [
      {
        id,
        sandboxId: sandbox.id,
        accountId: sandbox.accountId,
        contactId: "contact",
      },
    ],
  });
  const snapshot = () => handle.query<ConversationState>("getSnapshot");
  async function taskToken(invocationId: string) {
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT task_token FROM mock_calls WHERE invocation_id = $1",
              [invocationId],
            )
          ).rowCount,
      )
      .toBe(1);
    return (
      await pool.query<{ task_token: Buffer }>(
        "SELECT task_token FROM mock_calls WHERE invocation_id = $1",
        [invocationId],
      )
    ).rows[0]!.task_token;
  }

  return {
    env,
    pool,
    sandbox,
    handle,
    snapshot,
    async event(
      text: string,
      versions: WorkflowVersion[],
      kind: InputEvent["kind"] = "message",
      eventId: string = randomUUID(),
    ) {
      return handle.executeUpdate("acceptEvent", {
        args: [
          {
            eventId,
            ...(kind === "comment" ? { commentId: `comment:${eventId}` } : {}),
            text,
            kind,
            accountId: sandbox.accountId,
            contactId: "contact",
          },
          versions,
        ],
      });
    },
    async drain() {
      await expect
        .poll(async () => {
          const state = await snapshot();
          const now = await env.currentTimeMs();
          return (
            state.blocked && (state.nextAt === undefined || state.nextAt > now)
          );
        })
        .toBe(true);
      return snapshot();
    },
    async advance(milliseconds: number) {
      await this.drain();
      await env.sleep(milliseconds);
      return this.drain();
    },
    async complete(invocationId: string, result: unknown) {
      await env.client.activity.complete(await taskToken(invocationId), result);
    },
    async fail(invocationId: string, error: Error) {
      await env.client.activity.fail(await taskToken(invocationId), error);
    },
    async close() {
      worker.shutdown();
      await running;
      await env.teardown();
      await pool.end();
    },
  };
}

export const test = base.extend<{
  pool: Pool;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  h: Awaited<ReturnType<typeof createConversationHarness>>;
  normal: {
    runtime: Awaited<ReturnType<typeof createRuntime>>;
    fake: ReturnType<typeof createFakeApi>;
    taskQueue: string;
    restart(): Promise<void>;
  };
}>({
  pool: async ({}, use) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await use(pool);
    } finally {
      await pool.end();
    }
  },
  runtime: async ({ pool }, use) => {
    const runtime = await createRuntime({ pool, mode: "accelerated" });
    try {
      await use(runtime);
    } finally {
      await runtime.close();
    }
  },
  h: async ({}, use) => {
    const h = await createConversationHarness();
    try {
      await use(h);
    } finally {
      await h.close();
    }
  },
  normal: async ({ pool }, use, testInfo) => {
    const fake = createFakeApi();
    const externalApiUrl = await fake.server.listen({
      port: 0,
      host: "127.0.0.1",
    });
    const taskQueue = `recovery-${randomUUID()}`;
    const runtime = await createRuntime({ pool, mode: "normal", taskQueue });
    let worker = startNormalWorker(taskQueue, externalApiUrl);
    try {
      await use({
        runtime,
        fake,
        taskQueue,
        async restart() {
          await worker.stop(true);
          worker = startNormalWorker(taskQueue, externalApiUrl);
        },
      });
    } finally {
      await testInfo.attach("normal-worker.log", {
        body: worker.logs(),
        contentType: "text/plain",
      });
      await worker.stop();
      await runtime.close();
      await fake.server.close();
    }
  },
});
