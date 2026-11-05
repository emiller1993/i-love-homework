export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowDefinition {
  schemaVersion: 1;
  key: string;
  trigger: {
    kind: "comment" | "message";
    path: string;
    op: "equals" | "contains" | "is_email";
    value?: string;
  };
  start: string;
  steps: Step[];
  guard?:
    | { kind: "rule"; predicate: Omit<WorkflowDefinition["trigger"], "kind"> }
    | {
        kind: "classifier";
        agentVersion: string;
        timeoutMs: number;
        budget: number;
      };
}

export type Step = { id: string } & (
  | { kind: "reply_comment" | "send_message"; text: string; next: string }
  | {
      kind: "condition";
      path: string;
      op: "equals" | "contains" | "is_email";
      value?: string;
      then: string;
      else: string;
    }
  | {
      kind: "wait_message";
      accept: Omit<WorkflowDefinition["trigger"], "kind">;
      timeoutMs: number;
      next: string;
      onTimeout: string;
    }
  | {
      kind: "agent_call";
      agentVersion: string;
      timeoutMs: number;
      budget: number;
      resultSchema: Record<string, JsonValue>;
      next: string;
    }
  | { kind: "end" }
);

export interface WorkflowVersion {
  id: string;
  key: string;
  version: number;
  definition: WorkflowDefinition;
}

export interface InputEvent {
  eventId: string;
  accountId: string;
  contactId: string;
  kind: "comment" | "message";
  text: string;
  postId?: string;
  // Existing histories may omit this; new comment inputs must include it.
  commentId?: string;
}

export interface InputReceipt {
  eventId: string;
  conversationId: string;
  duplicate: boolean;
  applied: true;
}

export interface RunState {
  id: string;
  conversationId: string;
  workflowVersionId: string;
  triggerEventId: string;
  stepId: string;
  status:
    | "running"
    | "waiting"
    | "preparing"
    | "sending"
    | "completed"
    | "stopped"
    | "timed_out"
    | "failed";
  steps: Record<string, JsonValue>;
  error?: string;
}

export interface InvocationState {
  id: string;
  runId: string;
  conversationId: string;
  accountId: string;
  contactId: string;
  triggerEventId: string;
  workflowVersionId: string;
  callKind: "agent" | "classifier";
  stepId?: string;
  attempt: number;
  revision: number;
  agentVersion: string;
  budget: number;
  timeoutMs: number;
  resultSchema: Record<string, JsonValue>;
  input: JsonValue;
  status: "pending" | "accepted" | "obsolete" | "failed" | "timed_out";
  result?: JsonValue;
  error?: string;
  completedAt?: number;
}

export interface ActionRecord {
  id: string;
  sandboxId: string;
  conversationId: string;
  runId: string;
  accountId: string;
  contactId: string;
  channel: "comment" | "message";
  commentId?: string;
  text: string;
  status: "committed" | "completed" | "failed" | "unknown";
}

export interface TraceEntry {
  at: number;
  conversationId: string;
  runId?: string;
  kind: string;
  text: string;
}

export interface ConversationLimits {
  idleTimeoutMs: number;
  maxHistoryEvents: number;
  maxHistoryBytes: number;
}

export const conversationLimits: ConversationLimits = {
  idleTimeoutMs: 86_400_000,
  maxHistoryEvents: 10_000,
  maxHistoryBytes: 20 * 1024 * 1024,
};

export interface ConversationState {
  id: string;
  temporalRunId: string;
  status: "running" | "completed" | "failed";
  sandboxId: string;
  accountId: string;
  contactId: string;
  revision: number;
  events: InputEvent[];
  duplicates: number;
  runs: RunState[];
  invocations: InvocationState[];
  actions: ActionRecord[];
  trace: TraceEntry[];
  blocked: boolean;
  nextAt?: number;
  pending: { workflowVersionId: string; triggerEventId: string }[];
}

export interface SandboxRecord {
  id: string;
  accountId: string;
  workflowVersionIds: string[];
  mode: "normal" | "accelerated";
}

export interface SandboxSnapshot {
  sandbox: SandboxRecord;
  now: number;
  conversations: ConversationState[];
  runs: RunState[];
  invocations: InvocationState[];
  actions: ActionRecord[];
  messages: ActionRecord[];
  trace: TraceEntry[];
  blocked: boolean;
}

export type MockCompletion =
  { result: JsonValue; error?: never } | { error: string; result?: never };

export interface BacktestInput {
  workflowVersionIds: string[];
  until: number;
  timeline: ({ at: number } & (
    | { kind: "event"; event: InputEvent }
    | {
        kind: "completion";
        target: Pick<
          InvocationState,
          | "accountId"
          | "contactId"
          | "triggerEventId"
          | "workflowVersionId"
          | "callKind"
          | "attempt"
        > & { stepId?: string };
        completion: MockCompletion;
      }
  ))[];
}

export interface BacktestReport {
  id: string;
  events: number;
  duplicates: number;
  runs: RunState[];
  actions: ActionRecord[];
  messages: ActionRecord[];
  completed: number;
  stopped: number;
  timedOut: number;
  errors: string[];
  trace: TraceEntry[];
}

function readPath(path: string, input: unknown): unknown {
  if (!/^(event\.text|steps\.[a-zA-Z][\w-]*\.text)$/.test(path))
    throw new Error(`Unsupported path: ${path}`);
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined,
      input,
    );
}

export function evaluatePredicate(
  predicate: Omit<WorkflowDefinition["trigger"], "kind">,
  input: unknown,
): boolean {
  const value = readPath(predicate.path, input);
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  switch (predicate.op) {
    case "equals":
      return text === (predicate.value ?? "").trim().toLowerCase();
    case "contains":
      return text.includes((predicate.value ?? "").trim().toLowerCase());
    case "is_email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }
}

export function renderText(template: string, input: unknown): string {
  return template.replace(/\{\{(.*?)\}\}/g, (_, path: string) => {
    const value = readPath(path.trim(), input);
    if (typeof value !== "string") throw new Error(`Missing text at ${path}`);
    return value;
  });
}
