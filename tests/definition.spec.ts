import { expect } from "@playwright/test";
import { test, workflowFixture } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import {
  saveWorkflowVersion,
  createSandbox,
  loadSandboxVersions,
} from "../src/store.js";
import { exportWorkflow } from "../src/bff.js";
import { readFileSync } from "node:fs";
import {
  parseWorkflowFile,
  evaluatePredicate,
  renderText,
} from "../src/definition.js";

const source = readFileSync("fixtures/pricing.yaml", "utf8");

test("predicate paths cannot reference missing steps", () => {
  const definition = parseWorkflowFile(source, "yaml");
  const predicate = { path: "steps.typo.text", op: "equals", value: "yes" };
  const inputs = [
    { ...definition, trigger: { ...definition.trigger, path: predicate.path } },
    { ...definition, guard: { kind: "rule", predicate } },
    {
      ...definition,
      start: "choose",
      steps: [
        {
          id: "choose",
          kind: "condition",
          ...predicate,
          then: "reply",
          else: "end",
        },
        ...definition.steps,
      ],
    },
    {
      ...definition,
      steps: definition.steps.map((step) =>
        step.kind === "wait_message" ? { ...step, accept: predicate } : step,
      ),
    },
  ];
  for (const input of inputs)
    expect(() => parseWorkflowFile(JSON.stringify(input), "json")).toThrow();
});

test("YAML imports canonical JSON without executable values", () => {
  const definition = parseWorkflowFile(source, "yaml");
  expect(parseWorkflowFile(JSON.stringify(definition), "json")).toEqual(
    definition,
  );
  expect(definition.steps.map((step) => step.kind)).toEqual([
    "reply_comment",
    "send_message",
    "wait_message",
    "send_message",
    "end",
  ]);
});

test("invalid imports cannot become workflow versions", () => {
  const definition = parseWorkflowFile(source, "yaml");
  const invalid = [
    source.replace("path: event.text", "path: steps.email.text"),
    source + "\nkey: duplicate\n",
    source.replace("key: pricing", "key: !custom pricing"),
    source.replace("kind: end", "kind: unknown"),
    source.replace("next: ask", "next: missing"),
    source.replace("next: ask", "next: reply"),
    source.replace("key: pricing", "key: .nan"),
    source.replace("key: pricing", "key: &self [*self]"),
  ];
  for (const input of invalid)
    expect(() => parseWorkflowFile(input, "yaml")).toThrow();
  expect(() =>
    parseWorkflowFile(
      JSON.stringify({ ...definition, surprise: true }),
      "json",
    ),
  ).toThrow();
  const agent = {
    ...definition,
    steps: [
      {
        id: "call",
        kind: "agent_call",
        agentVersion: "v1",
        timeoutMs: 5000,
        budget: 1,
        resultSchema: { type: "nonsense" },
        next: "end",
      },
      { id: "end", kind: "end" },
    ],
    start: "call",
  };
  expect(() => parseWorkflowFile(JSON.stringify(agent), "json")).toThrow();
});

test("predicates and templates use data paths without evaluating code", () => {
  const input = {
    event: { text: "  PRICING  " },
    steps: { email: { text: "a@example.com" } },
  };
  expect(
    evaluatePredicate(
      { path: "event.text", op: "contains", value: "pricing" },
      input,
    ),
  ).toBe(true);
  expect(
    evaluatePredicate(
      { path: "event.text", op: "equals", value: " pricing " },
      input,
    ),
  ).toBe(true);
  for (const [text, expected] of [
    [" a@example.com ", true],
    ["hello a@example.com", false],
    ["a@b", false],
  ] as const) {
    expect(
      evaluatePredicate(
        { path: "event.text", op: "is_email" },
        { event: { text } },
      ),
    ).toBe(expected);
  }
  expect(renderText("For {{steps.email.text}} / {{event.text}}", input)).toBe(
    "For a@example.com /   PRICING  ",
  );
  expect(() => renderText("{{constructor.constructor}}", input)).toThrow();
  expect(() => renderText("{{steps.missing.text}}", input)).toThrow();
});

test("JSON duplicate keys are rejected before a version can be saved", () => {
  const definition = parseWorkflowFile(source, "yaml");
  const input = JSON.stringify(definition).replace(
    '"key":"pricing"',
    '"key":"pricing","key":"other"',
  );
  expect(() => parseWorkflowFile(input, "json")).toThrow();
});

test("agent output schemas are synchronous and scoped to each imported definition", () => {
  const definition = parseWorkflowFile(
    readFileSync("fixtures/agent.yaml", "utf8"),
    "yaml",
  );
  const step = definition.steps.find((value) => value.kind === "agent_call")!;
  step.resultSchema = { $async: true, type: "string" };
  expect(() => parseWorkflowFile(JSON.stringify(definition), "json")).toThrow();
  step.resultSchema = { $id: "https://example.com/result", type: "string" };
  const input = JSON.stringify(definition);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      parseWorkflowFile(input, "json").steps.find(
        (step) => step.kind === "agent_call",
      )?.resultSchema,
    ).toEqual({ $id: "https://example.com/result", type: "string" });
});

test("stored versions remain immutable and exports import as canonical definitions", async ({
  pool,
}) => {
  const definition = workflowFixture("pricing").definition;
  definition.key = `pricing-${randomUUID()}`;
  const first = await saveWorkflowVersion(pool, definition);
  const sandbox = await createSandbox(pool, [first.id], "normal");
  const file = await exportWorkflow(pool, first.id);
  const restored = parseWorkflowFile(file.content, "json");
  expect(restored).toEqual(definition);
  const second = await saveWorkflowVersion(pool, { ...restored, start: "end" });
  expect([first.version, second.version]).toEqual([1, 2]);
  expect(second.id).not.toBe(first.id);
  const selected = await loadSandboxVersions(pool, sandbox.id);
  expect(selected.map((version) => version.id)).toEqual([first.id]);
  expect(selected[0]!.definition.start).toBe("reply");
  await expect(exportWorkflow(pool, "unknown")).rejects.toThrow(
    "Unknown workflow",
  );
});
