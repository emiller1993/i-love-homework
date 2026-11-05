import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import serveStatic from "@fastify/static";
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { BacktestInput, InputEvent, MockCompletion } from "./domain.js";
import { parseWorkflowFile } from "./definition.js";
import { listWorkflowVersions, saveWorkflowVersion } from "./store.js";
import type { createRuntime } from "./runtime.js";
import { runBacktest } from "./backtest.js";
import { exportWorkflow, exportConversation, prepareBacktest } from "./bff.js";

const id = { type: "string", minLength: 1, maxLength: 500 };
const milliseconds = { type: "integer", minimum: 0, maximum: 86_400_000 };
const workflowVersionIds = {
  type: "array",
  maxItems: 100,
  uniqueItems: true,
  items: id,
};
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) {
  return { type: "object", properties, required, additionalProperties: false };
}
const event = object(
  {
    eventId: id,
    accountId: id,
    contactId: id,
    kind: { enum: ["comment", "message"] },
    text: { type: "string", minLength: 1, maxLength: 10000 },
    postId: id,
    commentId: id,
  },
  ["eventId", "accountId", "contactId", "kind", "text"],
);
const completion = {
  oneOf: [
    object({ result: {} }),
    object({ error: { type: "string", minLength: 1, maxLength: 1000 } }),
  ],
};
const backtest = object({
  workflowVersionIds,
  until: milliseconds,
  timeline: {
    type: "array",
    maxItems: 1000,
    items: {
      oneOf: [
        object({ at: milliseconds, kind: { const: "event" }, event }),
        object({
          at: milliseconds,
          kind: { const: "completion" },
          target: object(
            {
              accountId: id,
              contactId: id,
              triggerEventId: id,
              workflowVersionId: { type: "string", maxLength: 500 },
              callKind: { enum: ["agent", "classifier"] },
              stepId: id,
              attempt: { type: "integer", minimum: 1 },
            },
            [
              "accountId",
              "contactId",
              "triggerEventId",
              "workflowVersionId",
              "callKind",
              "attempt",
            ],
          ),
          completion,
        }),
      ],
    },
  },
});

export async function createServer(options: {
  pool: Pool;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
}): Promise<FastifyInstance> {
  const { pool, runtime } = options;
  const server = Fastify({
    logger: { level: "error" },
    routerOptions: { maxParamLength: 8192 },
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await server.register(multipart, {
    limits: { fileSize: 1024 * 1024, files: 1, parts: 1 },
  });
  await server.register(serveStatic, {
    root: resolve("src/web"),
  });
  server.setErrorHandler((error, request, reply) => {
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error instanceof Error &&
        "statusCode" in error &&
        typeof error.statusCode === "number" &&
        error.statusCode < 500)
    ) {
      void reply.code(400).send({ error: error.message });
    } else {
      request.log.error(error);
      void reply.code(500).send({ error: "Execution failed; see server logs" });
    }
  });

  server.get("/api/workflows", () => listWorkflowVersions(pool));
  server.get<{ Params: { workflowVersionId: string } }>(
    "/api/workflows/:workflowVersionId/export",
    async (request, reply) => {
      const file = await exportWorkflow(pool, request.params.workflowVersionId);
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="${file.filename}"`,
        )
        .type("application/json")
        .send(file.content);
    },
  );
  await server.register(async (server) => {
    server.removeContentTypeParser("application/json");
    server.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
    server.post("/api/workflows", async (request) => {
      let source: string;
      let format: "json" | "yaml" = "json";
      if (request.isMultipart()) {
        const file = await request.file();
        if (!file) throw new TypeError("A workflow file is required");
        source = (await file.toBuffer()).toString("utf8");
        if (/\.ya?ml$/i.test(file.filename)) format = "yaml";
        else if (!/\.json$/i.test(file.filename))
          throw new TypeError("Upload a JSON or YAML file");
      } else {
        if (
          typeof request.body !== "string" ||
          !request.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        )
          throw new TypeError("Submit JSON or upload a workflow file");
        source = request.body;
      }
      let definition;
      try {
        definition = parseWorkflowFile(source, format);
      } catch (error) {
        throw new TypeError(
          error instanceof Error ? error.message : "Invalid workflow",
          { cause: error },
        );
      }
      return saveWorkflowVersion(pool, definition);
    });
  });
  server.post<{ Body: { workflowVersionIds: string[] } }>(
    "/api/sandboxes",
    { schema: { body: object({ workflowVersionIds }) } },
    (request) => runtime.createSandbox(request.body.workflowVersionIds),
  );
  server.get<{ Params: { sandboxId: string } }>(
    "/api/sandboxes/:sandboxId",
    (request) => runtime.getSnapshot(request.params.sandboxId),
  );
  server.get<{ Params: { sandboxId: string; conversationId: string } }>(
    "/api/sandboxes/:sandboxId/conversations/:conversationId/export",
    async (request, reply) => {
      const input = await exportConversation(
        runtime,
        request.params.sandboxId,
        request.params.conversationId,
      );
      return reply
        .header(
          "Content-Disposition",
          'attachment; filename="conversation.json"',
        )
        .type("application/json")
        .send(input);
    },
  );
  server.patch<{
    Params: { sandboxId: string; workflowVersionId: string };
    Body: { enabled: boolean };
  }>(
    "/api/sandboxes/:sandboxId/workflows/:workflowVersionId",
    { schema: { body: object({ enabled: { type: "boolean" } }) } },
    async (request, reply) => {
      await runtime.setWorkflowEnabled(
        request.params.sandboxId,
        request.params.workflowVersionId,
        request.body.enabled,
      );
      return reply.code(204).send();
    },
  );
  server.post<{ Params: { sandboxId: string }; Body: InputEvent }>(
    "/api/sandboxes/:sandboxId/events",
    { schema: { body: event } },
    (request) => runtime.acceptEvent(request.params.sandboxId, request.body),
  );
  server.post<{ Params: { sandboxId: string; conversationId: string } }>(
    "/api/sandboxes/:sandboxId/conversations/:conversationId/stop",
    async (request, reply) => {
      await runtime.stopConversation(
        request.params.sandboxId,
        request.params.conversationId,
      );
      return reply.code(204).send();
    },
  );
  server.post<{
    Params: { sandboxId: string };
    Body: { milliseconds: number };
  }>(
    "/api/sandboxes/:sandboxId/time",
    { schema: { body: object({ milliseconds }) } },
    (request) =>
      runtime.advanceTime(request.params.sandboxId, request.body.milliseconds),
  );
  server.post<{ Params: { sandboxId: string; conversationId: string } }>(
    "/api/sandboxes/:sandboxId/conversations/:conversationId/restart",
    async (request, reply) => {
      await runtime.restartConversation(
        request.params.sandboxId,
        request.params.conversationId,
      );
      return reply.code(204).send();
    },
  );
  server.post<{
    Params: { sandboxId: string; invocationId: string };
    Body: MockCompletion;
  }>(
    "/api/sandboxes/:sandboxId/invocations/:invocationId",
    { schema: { body: completion } },
    async (request, reply) => {
      await runtime.completeInvocation(
        request.params.sandboxId,
        request.params.invocationId,
        request.body,
      );
      return reply.code(204).send();
    },
  );
  server.post<{ Body: BacktestInput }>(
    "/api/backtests",
    { schema: { body: backtest } },
    async (request) =>
      runBacktest(await prepareBacktest(pool, request.body), runtime, pool),
  );
  server.get<{ Params: { backtestId: string } }>(
    "/api/backtests/:backtestId",
    async (request) => {
      const result = await pool.query(
        "SELECT report FROM backtests WHERE id = $1 AND account_id = 'demo-account'",
        [request.params.backtestId],
      );
      if (!result.rows[0]) throw new RangeError("Unknown backtest");
      return result.rows[0].report;
    },
  );
  return server;
}
