import Ajv from "ajv";
import { parseDocument } from "yaml";
import type { WorkflowDefinition } from "./domain.js";
export { evaluatePredicate, renderText } from "./domain.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const id = {
  type: "string",
  pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
  maxLength: 100,
};
const path = {
  type: "string",
  pattern: "^(event\\.text|steps\\.[a-zA-Z][\\w-]*\\.text)$",
};
const text = { type: "string", maxLength: 10_000 };
const timeoutMs = { type: "integer", minimum: 1, maximum: 86_400_000 };
const predicate = {
  type: "object",
  additionalProperties: false,
  required: ["path", "op"],
  properties: {
    path,
    op: { enum: ["equals", "contains", "is_email"] },
    value: text,
  },
  if: {
    properties: { op: { enum: ["equals", "contains"] } },
    required: ["op"],
  },
  then: { properties: { value: text }, required: ["value"] },
};
const agent = {
  agentVersion: id,
  timeoutMs,
  budget: { type: "number", exclusiveMinimum: 0 },
};
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) {
  return { type: "object", additionalProperties: false, required, properties };
}
const step = (
  kind: string,
  properties: Record<string, unknown>,
  required?: string[],
) =>
  object({ id, kind: { const: kind }, ...properties }, [
    "id",
    "kind",
    ...(required ?? Object.keys(properties)),
  ]);
const validate = ajv.compile<WorkflowDefinition>(
  object(
    {
      schemaVersion: { const: 1 },
      key: id,
      trigger: {
        ...predicate,
        properties: {
          ...predicate.properties,
          path: { const: "event.text" },
          kind: { enum: ["comment", "message"] },
        },
        required: ["kind", "path", "op"],
      },
      start: id,
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          oneOf: [
            step("reply_comment", { text, next: id }),
            step("send_message", { text, next: id }),
            step("condition", { ...predicate.properties, then: id, else: id }, [
              "path",
              "op",
              "then",
              "else",
            ]),
            step("wait_message", {
              accept: predicate,
              timeoutMs,
              next: id,
              onTimeout: id,
            }),
            step("agent_call", {
              ...agent,
              resultSchema: { type: "object" },
              next: id,
            }),
            step("end", {}),
          ],
        },
      },
      guard: {
        oneOf: [
          object({ kind: { const: "rule" }, predicate }),
          object({ kind: { const: "classifier" }, ...agent }),
        ],
      },
    },
    ["schemaVersion", "key", "trigger", "start", "steps"],
  ),
);

export function parseWorkflowFile(
  source: string,
  format: "json" | "yaml",
): WorkflowDefinition {
  let value: unknown;
  if (format === "json") {
    value = JSON.parse(source);
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.some((error) => error.code === "DUPLICATE_KEY"))
      throw new Error("Duplicate JSON object keys");
  } else {
    const document = parseDocument(source, {
      uniqueKeys: true,
      schema: "core",
      strict: true,
    });
    if (document.errors.length || document.warnings.length)
      throw new Error("YAML must contain strict JSON data");
    value = document.toJS({ maxAliasCount: 0 });
  }
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Only finite JSON numbers are supported");
    return item;
  });
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
  const steps = new Map(value.steps.map((entry) => [entry.id, entry]));
  if (steps.size !== value.steps.length)
    throw new Error("Step IDs must be unique");
  function validatePath(reference: string) {
    if (!new RegExp(path.pattern).test(reference))
      throw new Error(`Unsupported path: ${reference}`);
    if (
      reference.startsWith("steps.") &&
      !steps.has(reference.split(".")[1] ?? "")
    )
      throw new Error(`Missing referenced step: ${reference}`);
  }
  validatePath(value.trigger.path);
  if (value.guard?.kind === "rule") validatePath(value.guard.predicate.path);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(stepId: string) {
    const entry = steps.get(stepId);
    if (!entry) throw new Error(`Missing step: ${stepId}`);
    if (visiting.has(stepId)) throw new Error("Workflow must be acyclic");
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    if (entry.kind === "condition") validatePath(entry.path);
    if (entry.kind === "wait_message") validatePath(entry.accept.path);
    if (entry.kind === "agent_call") {
      const result = new Ajv({ strict: true }).compile(entry.resultSchema);
      if ("$async" in result && result.$async)
        throw new Error("Result schemas must be synchronous");
    }
    if (
      entry.kind === "condition" &&
      entry.op !== "is_email" &&
      entry.value === undefined
    )
      throw new Error("Predicate value is required");
    if ("text" in entry) {
      for (const match of entry.text.matchAll(/\{\{(.*?)\}\}/g)) {
        const reference = match[1]?.trim() ?? "";
        validatePath(reference);
      }
    }
    const next =
      entry.kind === "end"
        ? []
        : entry.kind === "condition"
          ? [entry.then, entry.else]
          : entry.kind === "wait_message"
            ? [entry.next, entry.onTimeout]
            : [entry.next];
    for (const target of next) visit(target);
    visiting.delete(stepId);
    visited.add(stepId);
  }
  visit(value.start);
  for (const entry of value.steps) visit(entry.id);
  return JSON.parse(JSON.stringify(value)) as WorkflowDefinition;
}
