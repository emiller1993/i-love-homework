import { expect } from "@playwright/test";
import {
  test,
  createConversationHarness,
  workflowFixture,
} from "./fixtures.js";
import { createRuntime } from "../src/runtime.js";
import { saveWorkflowVersion, createSandbox } from "../src/store.js";
import { randomUUID } from "node:crypto";
import {
  exportConversation,
  exportWorkflow,
  prepareBacktest,
} from "../src/bff.js";
import { createMockActivities } from "../src/mock-activities.js";
import { ApplicationFailure } from "@temporalio/activity";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Activities } from "../src/activities.js";
import { runBacktest } from "../src/backtest.js";
import { readFileSync } from "node:fs";
import type {
  ActionRecord,
  BacktestInput,
  ConversationState,
  InputEvent,
  MockCompletion,
  WorkflowVersion,
} from "../src/domain.js";

test("classifier and agent call sites have independent logical attempts", async ({
  h,
}) => {
  const version = workflowFixture("agent");
  version.definition.guard = {
    kind: "classifier",
    agentVersion: "guard-v1",
    timeoutMs: 60000,
    budget: 1,
  };
  version.definition.start = "classifier";
  const step = version.definition.steps.find(
    (value) => value.kind === "agent_call",
  )!;
  step.id = "classifier";
  for (const value of version.definition.steps) {
    if (value.kind === "send_message") value.text = "{{steps.classifier.text}}";
  }
  await h.event("help", [version]);
  await h.advance(3100);
  await h.complete((await h.snapshot()).invocations[0]!.id, "continue");
  await expect
    .poll(async () => (await h.snapshot()).invocations.length)
    .toBe(2);
  expect(
    (await h.snapshot()).invocations.map((value) => [
      value.callKind,
      value.attempt,
    ]),
  ).toEqual([
    ["classifier", 1],
    ["agent", 1],
  ]);
});

test("a message applied at the wait deadline cannot beat its timeout", async ({
  h,
}) => {
  const versions = [workflowFixture("pricing")];
  await h.event("pricing", versions, "comment");
  await h.advance(3100);
  expect((await h.snapshot()).runs[0]?.status).toBe("waiting");
  const deadline = (await h.snapshot()).nextAt!;
  await h.advance(Math.max(0, deadline - (await h.env.currentTimeMs())));
  expect((await h.snapshot()).runs[0]?.status).toBe("timed_out");
  await h.event("late@example.com", versions);
  await h.advance(3100);
  expect((await h.snapshot()).runs[0]?.status).toBe("timed_out");
  expect((await h.snapshot()).actions).toHaveLength(2);
});

test("pending triggers run in acceptance order after the active conversation finishes", async ({
  h,
}) => {
  const pricing = workflowFixture("pricing");
  const catalog = workflowFixture("catalog");
  const versions = [pricing, catalog];
  await h.event("pricing", versions, "comment", "pricing-delivery");
  await h.advance(3100);
  await h.event("catalog first", versions, "comment", "first");
  await h.event("catalog second", versions, "comment", "second");
  await h.event("email@example.com", versions);
  await h.advance(3100);
  expect((await h.snapshot()).runs.map((run) => run.triggerEventId)).toEqual([
    expect.any(String),
    "first",
    "second",
  ]);
  expect((await h.snapshot()).runs.map((run) => run.status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  expect(
    (await h.snapshot()).actions.filter(
      (action) => action.channel === "comment",
    ),
  ).toMatchObject([
    { commentId: "comment:pricing-delivery" },
    { commentId: "comment:first" },
    { commentId: "comment:second" },
  ]);
});

test("backtests preserve the cutoff and persist repeatable per-contact outcomes", async ({
  pool,
  runtime,
}) => {
  const version = await saveWorkflowVersion(
    pool,
    workflowFixture("pricing").definition,
  );
  const input = JSON.parse(
    readFileSync("fixtures/pricing-history.json", "utf8"),
  ) as BacktestInput;
  input.workflowVersionIds = [version.id];
  const first = await runBacktest(input, runtime, pool);
  const second = await runBacktest(input, runtime, pool);
  expect(first.messages.map((message) => message.text)).toEqual(
    second.messages.map((message) => message.text),
  );
  expect(first.messages).toHaveLength(3);
  expect(first.completed).toBe(1);
  const waiting = await runBacktest(
    { ...input, until: 5000, timeline: [input.timeline[0]!] },
    runtime,
    pool,
  );
  expect(waiting.runs[0]?.status).toBe("waiting");
  expect(waiting.messages).toHaveLength(2);
  expect(
    (await pool.query("SELECT report FROM backtests WHERE id = $1", [first.id]))
      .rows[0]?.report.completed,
  ).toBe(1);
});

test("backtests can complete an obsolete call without advancing its replacement", async ({
  pool,
  runtime,
}) => {
  const version = await saveWorkflowVersion(
    pool,
    workflowFixture("agent").definition,
  );
  const input = JSON.parse(
    readFileSync("fixtures/interruption-history.json", "utf8"),
  ) as BacktestInput;
  input.workflowVersionIds = [version.id];
  for (const entry of input.timeline)
    if (entry.kind === "completion")
      entry.target.workflowVersionId = version.id;
  const full = await runBacktest(input, runtime, pool);
  expect(full.messages.map((message) => message.text)).toEqual([
    "Pricing and delivery explained",
  ]);
  const held = await runBacktest(
    { ...input, until: 8500, timeline: input.timeline.slice(0, 3) },
    runtime,
    pool,
  );
  expect(held.messages).toHaveLength(0);
  expect(held.runs[0]?.status).toBe("preparing");
  await expect(
    runBacktest(
      {
        ...input,
        timeline: [
          {
            at: 0,
            kind: "completion",
            target: {
              ...input.timeline.find((entry) => entry.kind === "completion")!
                .target,
              contactId: "missing",
            },
            completion: { result: { text: "x" } },
          },
        ],
      },
      runtime,
      pool,
    ),
  ).rejects.toThrow("does not exist");
});

test("pricing waits for a valid email and completes exactly three effects", async ({
  h,
}) => {
  const versions = [workflowFixture("pricing")];
  await h.event("PRICING", versions, "comment", "comment-1");
  await h.advance(3100);
  expect((await h.snapshot()).actions.map((action) => action.channel)).toEqual([
    "comment",
    "message",
  ]);
  await h.event("not an email", versions);
  await h.advance(3100);
  expect((await h.snapshot()).runs[0]?.status).toBe("waiting");
  await h.event(" person@example.com ", versions);
  await h.advance(3100);
  const state = await h.snapshot();
  expect(state.runs.map((run) => run.status)).toEqual(["completed"]);
  expect(state.actions.map((action) => action.text)).toEqual([
    "Thanks! Check your messages.",
    "What is your email?",
    "Pricing for person@example.com: https://example.com/pricing",
  ]);
  await h.event("PRICING", versions, "comment", "comment-1");
  expect((await h.snapshot()).duplicates).toBe(1);
  expect((await h.snapshot()).runs).toHaveLength(1);
});

test("a timeout releases the next FIFO trigger and disabled triggers stay discarded", async ({
  h,
}) => {
  const versions = [workflowFixture("pricing"), workflowFixture("catalog")];
  await h.event("pricing", versions, "comment");
  await h.advance(3100);
  await h.event("catalog", versions, "comment");
  await h.advance(3100);
  expect((await h.snapshot()).pending).toHaveLength(1);
  await h.handle.executeUpdate("setEnabled", { args: [[versions[0]]] });
  await h.handle.executeUpdate("setEnabled", { args: [versions] });
  await h.advance(61000);
  expect((await h.snapshot()).runs.map((run) => run.status)).toEqual([
    "timed_out",
  ]);
  await h.event("catalog", versions, "comment");
  await h.advance(3100);
  expect((await h.snapshot()).runs.map((run) => run.status)).toEqual([
    "timed_out",
    "completed",
  ]);
});

test("new context suppresses a late agent result and retains both messages", async ({
  h,
}) => {
  const versions = [workflowFixture("agent")];
  await h.event("help with pricing", versions);
  await h.advance(3100);
  const first = (await h.snapshot()).invocations[0]!;
  await h.event("also explain delivery", versions);
  await h.advance(3100);
  const second = (await h.snapshot()).invocations[1]!;
  expect(second.attempt).toBe(2);
  expect(JSON.stringify(second.input)).toContain("also explain delivery");
  await h.complete(first.id, { text: "obsolete" });
  await expect
    .poll(async () => (await h.snapshot()).invocations[0]?.result)
    .toEqual({ text: "obsolete" });
  expect((await h.snapshot()).actions).toHaveLength(0);
  await h.complete(second.id, { text: "Both requests answered" });
  await expect
    .poll(async () => (await h.snapshot()).runs[0]?.status)
    .toBe("completed");
  expect((await h.snapshot()).actions.map((action) => action.text)).toEqual([
    "Both requests answered",
  ]);
  expect(
    (await h.snapshot()).invocations.map((invocation) => invocation.status),
  ).toEqual(["obsolete", "accepted"]);
});

test("stop keeps a committed send fixed and clears buffered triggers", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await createConversationHarness(async (action) => {
    await held;
    return { ...action, status: "completed" };
  });
  try {
    const versions = [workflowFixture("catalog")];
    await h.event("catalog", versions, "comment");
    await h.env.sleep(3100);
    await expect
      .poll(async () => (await h.snapshot()).actions[0]?.status)
      .toBe("committed");
    await h.event("catalog again", versions, "comment");
    await h.handle.executeUpdate("stopConversation", { args: [] });
    release!();
    await expect
      .poll(async () => (await h.snapshot()).actions[0]?.status)
      .toBe("completed");
    await h.advance(4000);
    expect((await h.snapshot()).runs.map((run) => run.status)).toEqual([
      "stopped",
    ]);
    expect((await h.snapshot()).pending).toHaveLength(0);
    await h.event("catalog new", versions, "comment");
    await h.advance(3100);
    expect((await h.snapshot()).runs.map((run) => run.status)).toEqual([
      "stopped",
      "completed",
    ]);
    expect((await h.snapshot()).actions).toHaveLength(2);
  } finally {
    release!();
    await h.close();
  }
});

test("separate simulation clocks do not expire each other's waits", async () => {
  const a = await createConversationHarness();
  const b = await createConversationHarness();
  try {
    const versions = [workflowFixture("pricing")];
    await a.event("pricing", versions, "comment");
    await a.advance(3100);
    await b.event("pricing", versions, "comment");
    await b.advance(3100);
    await a.advance(61000);
    expect((await a.snapshot()).runs[0]?.status).toBe("timed_out");
    expect((await b.snapshot()).runs[0]?.status).toBe("waiting");
  } finally {
    await a.close();
    await b.close();
  }
});

test("batching starts preparation after ten seconds despite continuing input", async ({
  h,
}) => {
  const versions = [workflowFixture("agent")];
  await h.event("help", versions);
  for (let index = 0; index < 4; index++) {
    await h.advance(2000);
    await h.event(`detail ${index}`, versions);
  }
  expect((await h.snapshot()).invocations).toHaveLength(0);
  await h.advance(2100);
  expect((await h.snapshot()).invocations).toHaveLength(1);
  await h.handle.executeUpdate("stopConversation", { args: [] });
  await h.advance(4000);
  expect((await h.snapshot()).actions).toHaveLength(0);
});

test("a controlled classifier can silence a run before a condition and send", async ({
  h,
}) => {
  const version = workflowFixture("catalog");
  version.definition.guard = {
    kind: "classifier",
    agentVersion: "guard-v1",
    timeoutMs: 60000,
    budget: 1,
  };
  version.definition.steps.unshift({
    id: "choose",
    kind: "condition",
    path: "event.text",
    op: "contains",
    value: "catalog",
    then: "reply",
    else: "end",
  });
  version.definition.start = "choose";
  await h.event("catalog", [version], "comment");
  await h.advance(3100);
  await h.complete((await h.snapshot()).invocations[0]!.id, "stop");
  await expect
    .poll(async () => (await h.snapshot()).runs[0]?.status)
    .toBe("stopped");
  expect((await h.snapshot()).actions).toHaveLength(0);
  await h.event("catalog new", [version], "comment");
  await h.advance(3100);
  await h.complete((await h.snapshot()).invocations[1]!.id, "continue");
  await expect
    .poll(async () => (await h.snapshot()).runs[1]?.status)
    .toBe("completed");
  expect((await h.snapshot()).actions).toHaveLength(1);
});

const event: InputEvent = {
  eventId: "help",
  accountId: "demo-account",
  contactId: "contact",
  kind: "message",
  text: "help",
};

test("agent timeouts pause work without launching another invocation", async ({
  h,
}) => {
  const version = workflowFixture("agent");
  version.definition.steps.find(
    (step) => step.kind === "agent_call",
  )!.timeoutMs = 1000;
  await h.event("help", [version]);
  await h.advance(3100);
  const timed = await h.advance(1500);
  expect(timed.runs[0]?.status).toBe("timed_out");
  expect(timed.invocations[0]?.error).toBe("Invocation timed out");
  await h.event("help queued", [version]);
  expect((await h.advance(4000)).invocations).toHaveLength(1);
});

test("an empty SDK failure pauses work until stop clears the backlog", async ({
  h,
}) => {
  const versions = [workflowFixture("agent")];
  await h.event("help", versions);
  const invocation = (await h.advance(3100)).invocations[0]!;
  await h.fail(invocation.id, ApplicationFailure.nonRetryable(""));
  await expect
    .poll(async () => (await h.snapshot()).runs[0]?.status)
    .toBe("failed");
  await h.event("help queued", versions);
  const paused = await h.advance(3100);
  expect(paused.invocations).toHaveLength(1);
  expect(paused.actions).toHaveLength(0);
  expect(paused.invocations[0]?.error).toBe("Agent invocation failed");
  await h.handle.executeUpdate("stopConversation", { args: [] });
  await h.event("help new", versions);
  expect((await h.advance(3100)).runs.map((run) => run.status)).toEqual([
    "failed",
    "preparing",
  ]);
  expect((await h.snapshot()).pending).toHaveLength(0);
});

test("controlled sends retain one durable receipt across retries", async ({
  pool,
}) => {
  const sandbox = await createSandbox(pool, [], "normal");
  const action: ActionRecord = {
    id: `${sandbox.id}:send`,
    sandboxId: sandbox.id,
    conversationId: "contact",
    runId: "run",
    accountId: "demo-account",
    contactId: "contact",
    channel: "comment",
    text: "Hello",
    status: "committed",
  };
  const activities = createMockActivities(pool);
  await expect(activities.sendMessage(action)).rejects.toThrow("commentId");
  const addressed = { ...action, commentId: "original-comment" };
  expect(
    await Promise.all([
      activities.sendMessage(addressed),
      activities.sendMessage(addressed),
    ]),
  ).toMatchObject([{ status: "completed" }, { status: "completed" }]);
  expect(
    (
      await pool.query("SELECT text FROM deliveries WHERE action_id = $1", [
        action.id,
      ])
    ).rows,
  ).toEqual([{ text: "Hello" }]);
});

test("conversation exports preserve duplicate inputs and contact isolation", async ({
  pool,
  runtime,
}) => {
  const version = await saveWorkflowVersion(
    pool,
    workflowFixture("pricing").definition,
  );
  const sandbox = await runtime.createSandbox([version.id]);
  await expect(
    runtime.acceptEvent(sandbox.id, {
      ...event,
      kind: "comment",
      text: "pricing",
    }),
  ).rejects.toThrow("commentId");
  const comment = {
    ...event,
    kind: "comment" as const,
    commentId: "original-comment",
    text: "pricing",
  };
  const receipt = await runtime.acceptEvent(sandbox.id, comment);
  await runtime.acceptEvent(sandbox.id, comment);
  await runtime.acceptEvent(sandbox.id, {
    ...event,
    eventId: "private",
    contactId: "bob",
    text: "Bob private message",
  });
  await runtime.advanceTime(sandbox.id, 4000);
  await runtime.acceptEvent(sandbox.id, {
    ...event,
    eventId: "email",
    text: "person@example.com",
  });
  await runtime.advanceTime(sandbox.id, 4000);
  const source = await exportConversation(
    runtime,
    sandbox.id,
    receipt.conversationId,
  );
  const input = JSON.parse(source) as BacktestInput;
  expect(
    input.timeline.map(
      (entry) => entry.kind === "event" && entry.event.eventId,
    ),
  ).toEqual(["help", "help", "email"]);
  expect(input.timeline[0]!.at).toBe(0);
  expect(input.timeline[0]).toMatchObject({
    event: { commentId: "original-comment" },
  });
  expect(source).not.toContain("Bob private message");
  expect(source).not.toContain("task_token");
  const report = await runBacktest(input, runtime, pool);
  expect(report.messages[0]).toMatchObject({ commentId: "original-comment" });
  expect([report.events, report.duplicates, report.completed]).toEqual([
    2, 1, 1,
  ]);
  expect(report.messages.map((message) => message.text)).toEqual([
    "Thanks! Check your messages.",
    "What is your email?",
    "Pricing for person@example.com: https://example.com/pricing",
  ]);
  const other = await runtime.createSandbox([version.id]);
  await expect(
    exportConversation(runtime, other.id, receipt.conversationId),
  ).rejects.toThrow("Unknown conversation");
  await expect(
    runtime.acceptEvent(sandbox.id, { ...event, accountId: "foreign" }),
  ).rejects.toThrow("Account");
  await runtime.acceptEvent(other.id, comment);
  expect((await runtime.advanceTime(other.id, 4000)).messages).toHaveLength(2);
});

test("agent recordings keep the first completion time and replay on an edited version", async ({
  pool,
  runtime,
}) => {
  const definition = workflowFixture("agent").definition;
  const version = await saveWorkflowVersion(pool, definition);
  const sandbox = await runtime.createSandbox([version.id]);
  const receipt = await runtime.acceptEvent(sandbox.id, event);
  const first = (await runtime.advanceTime(sandbox.id, 4000)).invocations[0]!;
  await expect(
    runtime.completeInvocation(sandbox.id, first.id, {
      result: { wrong: true },
    }),
  ).rejects.toThrow("Invalid result");
  const other = await runtime.createSandbox([version.id]);
  await expect(
    runtime.completeInvocation(other.id, first.id, {
      result: { text: "wrong contact" },
    }),
  ).rejects.toThrow("Unknown invocation");
  await runtime.acceptEvent(sandbox.id, {
    ...event,
    eventId: "detail",
    text: "and delivery",
  });
  const second = (await runtime.advanceTime(sandbox.id, 4000)).invocations[1]!;
  await runtime.completeInvocation(sandbox.id, first.id, {
    result: { text: "Old" },
  });
  await runtime.completeInvocation(sandbox.id, second.id, {
    result: { text: "Combined" },
  });
  const clock = async () =>
    (
      await pool.query(
        "SELECT completed_clock_at FROM mock_calls WHERE invocation_id = $1",
        [first.id],
      )
    ).rows[0].completed_clock_at;
  const recorded = await clock();
  expect(Number(recorded)).toBeGreaterThan(0);
  await runtime.advanceTime(sandbox.id, 1000);
  await runtime.completeInvocation(sandbox.id, first.id, {
    result: { text: "Old" },
  });
  expect(await clock()).toBe(recorded);
  await expect(
    runtime.completeInvocation(sandbox.id, first.id, {
      result: { text: "Different" },
    }),
  ).rejects.toThrow("different completion");
  const input = JSON.parse(
    await exportConversation(runtime, sandbox.id, receipt.conversationId),
  ) as BacktestInput;
  expect(
    input.timeline.flatMap((entry) =>
      entry.kind === "completion" ? [entry.completion] : [],
    ),
  ).toEqual([{ result: { text: "Old" } }, { result: { text: "Combined" } }]);
  for (const step of definition.steps)
    if (step.kind === "send_message")
      step.text = "Updated: {{steps.prepare.text}}";
  const selected = await saveWorkflowVersion(pool, definition);
  const changed = { ...input, workflowVersionIds: [selected.id] };
  const report = await runBacktest(
    await prepareBacktest(pool, changed),
    runtime,
    pool,
  );
  expect(report.messages.map((message) => message.text)).toEqual([
    "Updated: Combined",
  ]);
  const ambiguous = await saveWorkflowVersion(pool, definition);
  await expect(
    prepareBacktest(pool, {
      ...changed,
      workflowVersionIds: [selected.id, ambiguous.id],
    }),
  ).rejects.toThrow("one selected version");
  const unrelated = await saveWorkflowVersion(
    pool,
    workflowFixture("pricing").definition,
  );
  await expect(
    prepareBacktest(pool, { ...changed, workflowVersionIds: [unrelated.id] }),
  ).rejects.toThrow("one selected version");
  await pool.query(
    "UPDATE mock_calls SET completed_clock_at=NULL WHERE invocation_id=$1",
    [first.id],
  );
  await expect(
    exportConversation(runtime, sandbox.id, receipt.conversationId),
  ).resolves.toContain("Old");
});

test("exports replay null and errors and explain unsupported long errors", async ({
  pool,
  runtime,
}) => {
  const definition = workflowFixture("agent").definition;
  const prepare = definition.steps.find((step) => step.kind === "agent_call")!;
  prepare.resultSchema = { type: "null" };
  prepare.next = "end";
  const version = await saveWorkflowVersion(pool, definition);
  const sandbox = await runtime.createSandbox([version.id]);
  const cases: [string, MockCompletion][] = [
    ["null", { result: null }],
    ["error", { error: "Agent unavailable" }],
    ["long", { error: "x".repeat(1001) }],
  ];
  for (const [contactId, completion] of cases) {
    const receipt = await runtime.acceptEvent(sandbox.id, {
      ...event,
      eventId: contactId,
      contactId,
    });
    const invocation = (
      await runtime.advanceTime(sandbox.id, 4000)
    ).invocations.find(
      (value) => value.conversationId === receipt.conversationId,
    )!;
    await runtime.completeInvocation(sandbox.id, invocation.id, completion);
    if (completion.error?.length === 1001) {
      expect(
        (await runtime.getSnapshot(sandbox.id)).invocations.find(
          (value) => value.id === invocation.id,
        )?.error,
      ).toHaveLength(1001);
      await expect(
        exportConversation(runtime, sandbox.id, receipt.conversationId),
      ).rejects.toThrow("1000-character");
    } else {
      const input = JSON.parse(
        await exportConversation(runtime, sandbox.id, receipt.conversationId),
      ) as BacktestInput;
      expect(
        input.timeline.find((entry) => entry.kind === "completion")?.completion,
      ).toEqual(completion);
      const report = await runBacktest(input, runtime, pool);
      expect(report.errors).toEqual(completion.error ? [completion.error] : []);
      expect(report.completed).toBe(completion.error ? 0 : 1);
    }
  }
});

test("exports preserve no-op workflow order and reject manual edits", async ({
  pool,
  runtime,
}) => {
  const saved = [];
  for (const key of ["first", "second"]) {
    const definition = workflowFixture("catalog").definition;
    definition.key = key;
    for (const step of definition.steps)
      if (step.kind === "reply_comment") step.text = key;
    saved.push(await saveWorkflowVersion(pool, definition));
  }
  saved.sort((a, b) => b.id.localeCompare(a.id));
  const ids = saved.map((version) => version.id);
  const sandbox = await runtime.createSandbox(ids);
  const receipt = await runtime.acceptEvent(sandbox.id, {
    ...event,
    kind: "comment",
    commentId: "catalog-comment",
    text: "catalog",
  });
  await runtime.advanceTime(sandbox.id, 4000);
  await runtime.setWorkflowEnabled(sandbox.id, ids[0]!, true);
  const input = JSON.parse(
    await exportConversation(runtime, sandbox.id, receipt.conversationId),
  ) as BacktestInput;
  expect(input.workflowVersionIds).toEqual(ids);
  expect(
    (await runBacktest(input, runtime, pool)).messages.map(
      (action) => action.text,
    ),
  ).toEqual(saved.map((version) => version.key));
  await runtime.setWorkflowEnabled(sandbox.id, ids[0]!, false);
  await expect(
    exportConversation(runtime, sandbox.id, receipt.conversationId),
  ).rejects.toThrow("workflow changes");
  const other = await runtime.createSandbox(ids);
  const manual = await runtime.acceptEvent(other.id, {
    ...event,
    kind: "comment",
    commentId: "catalog-comment",
    text: "catalog",
  });
  await runtime.stopConversation(other.id, manual.conversationId);
  await expect(
    exportConversation(runtime, other.id, manual.conversationId),
  ).rejects.toThrow("manual Stop");
});

test("automatic classifier stops remain replayable", async ({
  pool,
  runtime,
}) => {
  const definition = workflowFixture("agent").definition;
  definition.guard = {
    kind: "classifier",
    agentVersion: "guard-v1",
    timeoutMs: 60000,
    budget: 1,
  };
  const version = await saveWorkflowVersion(pool, definition);
  const sandbox = await runtime.createSandbox([version.id]);
  const receipt = await runtime.acceptEvent(sandbox.id, event);
  const invocation = (await runtime.advanceTime(sandbox.id, 4000))
    .invocations[0]!;
  await runtime.completeInvocation(sandbox.id, invocation.id, {
    result: "stop",
  });
  const input = JSON.parse(
    await exportConversation(runtime, sandbox.id, receipt.conversationId),
  ) as BacktestInput;
  expect((await runBacktest(input, runtime, pool)).stopped).toBe(1);
});

test("export limits explain oversized workflow and conversation files", async ({
  pool,
  runtime,
}) => {
  const definition = workflowFixture("catalog").definition;
  definition.key = `large-${randomUUID()}`;
  definition.steps = Array.from({ length: 80 }, (_, index) => ({
    id: `send${index}`,
    kind: "send_message" as const,
    text: '"'.repeat(10000),
    next: index === 79 ? "end" : `send${index + 1}`,
  }));
  definition.steps.push({ id: "end", kind: "end" });
  definition.start = "send0";
  const version = await saveWorkflowVersion(pool, definition);
  try {
    await expect(exportWorkflow(pool, version.id)).rejects.toThrow(
      "import limit",
    );
    const sandbox = await runtime.createSandbox([]);
    let conversationId = "";
    for (let index = 0; index < 110; index++)
      conversationId = (
        await runtime.acceptEvent(sandbox.id, {
          ...event,
          text: "x".repeat(10000),
        })
      ).conversationId;
    await expect(
      exportConversation(runtime, sandbox.id, conversationId),
    ).rejects.toThrow("import limit");
  } finally {
    await pool.query("DELETE FROM workflow_versions WHERE id=$1", [version.id]);
    await pool.query(
      "DELETE FROM workflows WHERE key=$1 AND account_id='demo-account'",
      [definition.key],
    );
  }
});

test("normal Temporal expires queued agent and classifier calls before a worker starts", async () => {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS,
  });
  const options = {
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: `queued-${randomUUID()}`,
  };
  const client = new Client(options);
  try {
    const worker = await Worker.create({
      ...options,
      workflowsPath: require.resolve("../dist/src/conversation.js"),
    });
    await worker.runUntil(async () => {
      const agent = workflowFixture("agent");
      agent.definition.steps.find(
        (step) => step.kind === "agent_call",
      )!.timeoutMs = 1000;
      const classifier = workflowFixture("agent");
      classifier.definition.guard = {
        kind: "classifier",
        agentVersion: "guard-v1",
        timeoutMs: 1000,
        budget: 1,
      };
      async function start(contactId: string, version: WorkflowVersion) {
        const id = `${options.taskQueue}:${contactId}`;
        const handle = await client.workflow.start("conversationWorkflow", {
          workflowId: id,
          taskQueue: options.taskQueue,
          args: [
            {
              id,
              sandboxId: options.taskQueue,
              accountId: event.accountId,
              contactId,
            },
          ],
        });
        await handle.executeUpdate("acceptEvent", {
          args: [{ ...event, contactId }, [version]],
        });
        return handle;
      }
      const expired = [
        await start("agent", agent),
        await start("classifier", classifier),
      ];
      await expect
        .poll(async () =>
          Promise.all(
            expired.map(
              async (handle) =>
                (await handle.query<ConversationState>("getSnapshot")).runs[0]
                  ?.status,
            ),
          ),
        )
        .toEqual(["timed_out", "timed_out"]);
      await expect
        .poll(
          async () =>
            Promise.all(
              expired.map(
                async (handle) =>
                  (await handle.describe()).raw.pendingActivities?.length ?? 0,
              ),
            ),
          { timeout: 3000 },
        )
        .toEqual([0, 0]);

      const calls: string[] = [];
      const activities: Activities = {
        async executeAgent({ invocation }) {
          calls.push(invocation.id);
          return invocation.callKind === "classifier"
            ? "continue"
            : { text: "Hello" };
        },
        async sendMessage(action) {
          return { ...action, status: "completed" };
        },
      };
      const activityWorker = await Worker.create({ ...options, activities });
      await activityWorker.runUntil(async () => {
        const fresh = await start("fresh", agent);
        await expect
          .poll(
            async () =>
              (await fresh.query<ConversationState>("getSnapshot")).runs[0]
                ?.status,
          )
          .toBe("completed");
        const state = await fresh.query<ConversationState>("getSnapshot");
        expect(calls).toEqual([state.invocations[0]!.id]);
      });
    });
  } finally {
    await connection.close();
  }
});

test("normal Temporal resumes after worker loss and deduplicates independent clients", async ({
  pool,
  normal,
}) => {
  const second = await createRuntime({
    pool,
    mode: "normal",
    taskQueue: normal.taskQueue,
  });
  try {
    const definition = workflowFixture("agent").definition;
    const prepare = definition.steps.find(
      (step) => step.kind === "agent_call",
    )!;
    const email = workflowFixture("pricing").definition.steps.find(
      (step) => step.kind === "wait_message",
    )!;
    prepare.next = email.id;
    definition.steps.push({ ...email, next: "send" });
    const version = await saveWorkflowVersion(pool, definition);
    const sandbox = await normal.runtime.createSandbox([version.id]);
    const receipts = await Promise.all([
      normal.runtime.acceptEvent(sandbox.id, event),
      second.acceptEvent(sandbox.id, event),
    ]);
    expect(receipts.map((receipt) => receipt.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    await expect
      .poll(async () => (await second.getSnapshot(sandbox.id)).runs[0]?.status)
      .toBe("waiting");
    await normal.restart();
    await second.acceptEvent(sandbox.id, {
      ...event,
      eventId: "email",
      text: "person@example.com",
    });
    await expect
      .poll(async () => (await second.getSnapshot(sandbox.id)).runs[0]?.status)
      .toBe("completed");
    expect(
      [...normal.fake.deliveries.values()].map((action) => action.text),
    ).toEqual(["Fake agent response"]);
    expect((await second.acceptEvent(sandbox.id, event)).duplicate).toBe(true);
    expect((await second.getSnapshot(sandbox.id)).runs).toHaveLength(1);
    await expect(second.advanceTime(sandbox.id, 1000)).rejects.toThrow(
      "accelerated sandbox",
    );
  } finally {
    await second.close();
  }
});

test("normal replay uses recorded HTTP results without controlled mock rows", async ({
  pool,
  runtime,
  normal,
}) => {
  const version = await saveWorkflowVersion(
    pool,
    workflowFixture("agent").definition,
  );
  const sandbox = await normal.runtime.createSandbox([version.id]);
  const receipt = await normal.runtime.acceptEvent(sandbox.id, event);
  await expect
    .poll(
      async () =>
        (await normal.runtime.getSnapshot(sandbox.id)).runs[0]?.status,
    )
    .toBe("completed");
  expect(
    (
      await pool.query(
        "SELECT invocation_id FROM mock_calls WHERE sandbox_id=$1",
        [sandbox.id],
      )
    ).rowCount,
  ).toBe(0);
  const input = JSON.parse(
    await exportConversation(
      normal.runtime,
      sandbox.id,
      receipt.conversationId,
    ),
  ) as BacktestInput;
  expect(
    input.timeline.flatMap((entry) =>
      entry.kind === "completion" ? [entry.completion] : [],
    ),
  ).toEqual([{ result: { text: "Fake agent response" } }]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await runBacktest(input, runtime, pool);
    expect(report.messages.map((action) => action.text)).toEqual([
      "Fake agent response",
    ]);
  }
  expect(normal.fake.deliveries.size).toBe(1);
  const definition = workflowFixture("agent").definition;
  const prepare = definition.steps.find((step) => step.kind === "agent_call")!;
  prepare.resultSchema = { type: "null" };
  const invalid = await saveWorkflowVersion(pool, definition);
  const failed = await normal.runtime.createSandbox([invalid.id]);
  const failure = await normal.runtime.acceptEvent(failed.id, event);
  await expect
    .poll(
      async () => (await normal.runtime.getSnapshot(failed.id)).runs[0]?.status,
    )
    .toBe("failed");
  const snapshot = await normal.runtime.getSnapshot(failed.id);
  expect(snapshot.runs[0]?.error).toContain("Invalid result");
  const recorded = JSON.parse(
    await exportConversation(normal.runtime, failed.id, failure.conversationId),
  ) as BacktestInput;
  const report = await runBacktest(recorded, runtime, pool);
  expect(report.errors).toEqual([snapshot.runs[0]?.error]);
  expect(report.messages).toEqual([]);
  expect(normal.fake.deliveries.size).toBe(1);
  await expect(
    normal.runtime.completeInvocation(failed.id, snapshot.invocations[0]!.id, {
      result: null,
    }),
  ).rejects.toThrow("Manual completion");
});
