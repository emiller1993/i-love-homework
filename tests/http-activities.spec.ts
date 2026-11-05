import { expect } from "@playwright/test";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createFakeApi } from "../src/fake-api.js";
import { createHttpActivities } from "../src/http-activities.js";
import type { ActionRecord, InvocationState } from "../src/domain.js";
import { test } from "./fixtures.js";

const invocation: InvocationState = {
  id: "invocation",
  runId: "run",
  conversationId: "conversation",
  accountId: "demo-account",
  contactId: "contact",
  triggerEventId: "help",
  workflowVersionId: "agent-v1",
  callKind: "agent",
  stepId: "prepare",
  attempt: 1,
  revision: 1,
  agentVersion: "assistant-v1",
  budget: 1,
  timeoutMs: 1000,
  resultSchema: {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: { text: { type: "string" } },
  },
  input: { event: { text: "help" }, history: [], steps: {} },
  status: "pending",
};

test("external HTTP adapter honors typed JSON replies and stable send identities", async () => {
  const fake = createFakeApi();
  let override: { status: number; body: string } | undefined;
  fake.server.addHook("onSend", async (_request, reply, payload) => {
    if (!override) return payload;
    reply.code(override.status);
    return override.body;
  });
  const url = await fake.server.listen({ port: 0, host: "127.0.0.1" });
  const activities = createHttpActivities(url);
  const environment = new MockActivityEnvironment();
  const input = { sandboxId: "sandbox", invocation: { ...invocation } };
  const call = () => environment.run(() => activities.executeAgent(input));
  try {
    const response = await fetch(`${url}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        invocation: { ...invocation, callKind: "classifier" },
      }),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ result: "continue" });
    expect(await call()).toEqual({ text: "Fake agent response" });
    input.invocation.callKind = "classifier";
    input.invocation.resultSchema = { enum: ["continue", "stop"] };
    expect(await call()).toBe("continue");
    input.invocation.resultSchema = { type: "null" };
    override = { status: 200, body: '{"result":null}' };
    expect(await call()).toBeNull();
    input.invocation.resultSchema = invocation.resultSchema;
    for (const [status, body, error] of [
      [200, "{}", /invalid agent response/],
      [200, '{"result":42}', /Invalid result/],
      [200, "{", /JSON|property name/],
      [503, "{}", /HTTP 503/],
    ] as const) {
      override = { status, body };
      await expect(call()).rejects.toThrow(error);
    }
    override = undefined;
    const action: ActionRecord = {
      id: "send",
      sandboxId: "sandbox",
      conversationId: "conversation",
      runId: "run",
      accountId: "demo-account",
      contactId: "contact",
      channel: "comment",
      text: "Thanks",
      status: "committed",
    };
    await expect(
      environment.run(() => activities.sendMessage(action)),
    ).rejects.toThrow("commentId");
    expect(fake.deliveries.size).toBe(0);
    const addressed = { ...action, commentId: "original-comment" };
    const send = () => environment.run(() => activities.sendMessage(addressed));
    expect(await Promise.all([send(), send()])).toMatchObject([
      { status: "completed" },
      { status: "completed" },
    ]);
    expect([...fake.deliveries.values()]).toEqual([addressed]);
    override = { status: 200, body: '{"id":"wrong"}' };
    await expect(send()).rejects.toThrow("invalid send receipt");
  } finally {
    await fake.server.close();
  }
});
