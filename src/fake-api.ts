import Fastify from "fastify";
import type { Activities, AgentReply } from "./activities.js";
import type { ActionRecord } from "./domain.js";

export function createFakeApi(
  executeAgent: Activities["executeAgent"] = async ({ invocation }) =>
    invocation.callKind === "classifier"
      ? "continue"
      : { text: "Fake agent response" },
) {
  const server = Fastify();
  const deliveries = new Map<string, ActionRecord>();
  server.post<{
    Body: Parameters<Activities["executeAgent"]>[0];
    Reply: AgentReply;
  }>("/agent", async (request) => ({
    result: await executeAgent(request.body),
  }));
  server.post<{ Body: ActionRecord; Reply: Pick<ActionRecord, "id"> }>(
    "/messages",
    async (request) => {
      const action = request.body;
      if (!deliveries.has(action.id)) deliveries.set(action.id, action);
      return { id: action.id };
    },
  );
  return { server, deliveries };
}

if (require.main === module)
  void createFakeApi()
    .server.listen({ port: 8081, host: "0.0.0.0" })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
