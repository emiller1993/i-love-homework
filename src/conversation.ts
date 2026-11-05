import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  condition,
  defineQuery,
  defineUpdate,
  patched,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type { createLifecycleActivities } from "./lifecycle.js";
import {
  evaluatePredicate,
  renderText,
  type ActionRecord,
  type ConversationState,
  type ConversationLimits,
  type InputEvent,
  type InputReceipt,
  type InvocationState,
  type JsonValue,
  type RunState,
  type WorkflowVersion,
} from "./domain.js";

const acceptEvent = defineUpdate<InputReceipt, [InputEvent, WorkflowVersion[]]>(
  "acceptEvent",
);
const stopConversation = defineUpdate<void>("stopConversation");
const setEnabled = defineUpdate<void, [WorkflowVersion[]]>("setEnabled");
const getSnapshot = defineQuery<ConversationState>("getSnapshot");
const { sendMessage } = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});
const { saveConversation } = proxyActivities<
  ReturnType<typeof createLifecycleActivities>
>({
  startToCloseTimeout: "30 seconds",
});

function isStopped(run: RunState): boolean {
  return run.status === "stopped";
}

export async function conversationWorkflow(
  input: Pick<
    ConversationState,
    "id" | "sandboxId" | "accountId" | "contactId"
  > & { limits?: ConversationLimits; restarted?: boolean },
): Promise<void> {
  const state: ConversationState = {
    id: input.id,
    sandboxId: input.sandboxId,
    accountId: input.accountId,
    contactId: input.contactId,
    temporalRunId: workflowInfo().runId,
    status: "running",
    revision: 0,
    events: [],
    duplicates: 0,
    runs: [],
    invocations: [],
    actions: [],
    trace: [],
    pending: [],
    blocked: false,
  };
  const definitions = new Map<string, WorkflowVersion>();
  const seen = new Set<string>();
  const eventTimes = new Map<string, number>();
  let enabled = new Set<string>();
  let configurationRevision = 0;
  let buffered: number[] = [];
  let paused = false;
  // Keep this legacy fallback fixed; new defaults arrive in the Workflow's start input.
  const limits = input.limits ?? {
    idleTimeoutMs: 86_400_000,
    maxHistoryEvents: 10_000,
    maxHistoryBytes: 20 * 1024 * 1024,
  };
  const pendingAgents = new Map<string, number>();
  let idleSince: number | undefined;
  let limitFailure: ApplicationFailure | undefined;
  let lifecycleActive = false;
  function lifecycleEnabled() {
    const enabled = patched("conversation-lifecycle");
    lifecycleActive ||= enabled;
    return enabled;
  }
  function historyLimitReached() {
    return (
      workflowInfo().historyLength >= limits.maxHistoryEvents ||
      workflowInfo().historySize >= limits.maxHistoryBytes
    );
  }
  function overLimit() {
    return lifecycleEnabled() && historyLimitReached();
  }
  function checkLimit() {
    if (!overLimit()) return;
    limitFailure = ApplicationFailure.nonRetryable(
      "Conversation history limit reached; explicit restart required",
      "ConversationLimits",
    );
    throw limitFailure;
  }
  let active:
    | {
        run: RunState;
        version: WorkflowVersion;
        event: InputEvent;
        cursor: number;
        guardRevision: number;
        deadline?: number;
        timedOut: boolean;
        attempts: Map<string, number>;
      }
    | undefined;

  function trace(kind: string, text: string, runId = active?.run.id) {
    state.trace.push({
      at: Date.now(),
      conversationId: state.id,
      runId,
      kind,
      text,
    });
  }
  if (input.restarted) trace("restarted", "Conversation restarted by user");
  function updateEnabled(versions: WorkflowVersion[]) {
    const next = new Set(versions.map((version) => version.id));
    if (
      state.events.length > 0 &&
      (next.size !== enabled.size || [...next].some((id) => !enabled.has(id)))
    )
      trace("configuration_changed", "Enabled workflow versions changed");
    enabled = next;
    for (const version of versions) definitions.set(version.id, version);
    state.pending = state.pending.filter((trigger) => {
      if (enabled.has(trigger.workflowVersionId)) return true;
      trace("discarded", `Disabled workflow ${trigger.workflowVersionId}`);
      return false;
    });
    configurationRevision++;
  }
  function stop(manual = false) {
    if (
      active &&
      !["completed", "stopped", "timed_out", "failed"].includes(
        active.run.status,
      )
    )
      active.run.status = "stopped";
    for (const invocation of state.invocations)
      if (invocation.status === "pending") invocation.status = "obsolete";
    state.pending = [];
    buffered = [];
    paused = false;
    state.revision++;
    state.blocked = false;
    trace(
      "stopped",
      manual ? "Stopped by user" : "Future work and buffered input cleared",
    );
  }
  setHandler(getSnapshot, () => state);
  const validateOpen = () => {
    if (
      state.status !== "running" ||
      (lifecycleActive && historyLimitReached())
    )
      throw ApplicationFailure.nonRetryable(
        "Conversation is closing",
        "ConversationClosed",
      );
  };
  setHandler(
    setEnabled,
    (versions) => {
      updateEnabled(versions);
    },
    { validator: (_versions: WorkflowVersion[]) => validateOpen() },
  );
  // Updates only record input. The single main loop owns step transitions.
  setHandler(
    acceptEvent,
    (event, versions) => {
      if (seen.has(event.eventId)) {
        state.duplicates++;
        trace("duplicate", event.eventId);
        return {
          eventId: event.eventId,
          conversationId: state.id,
          duplicate: true,
          applied: true,
        };
      }
      updateEnabled(versions);
      seen.add(event.eventId);
      state.events.push(event);
      eventTimes.set(event.eventId, Date.now());
      state.revision++;
      idleSince = undefined;
      buffered.push(Date.now());
      state.blocked = false;
      for (const version of versions) {
        if (
          version.definition.trigger.kind === event.kind &&
          evaluatePredicate(version.definition.trigger, { event, steps: {} })
        )
          state.pending.push({
            workflowVersionId: version.id,
            triggerEventId: event.eventId,
          });
      }
      trace("input", `${event.kind}: ${event.text}`);
      return {
        eventId: event.eventId,
        conversationId: state.id,
        duplicate: false,
        applied: true,
      };
    },
    {
      validator: (_event: InputEvent, _versions: WorkflowVersion[]) =>
        validateOpen(),
    },
  );
  setHandler(stopConversation, () => stop(true), { validator: validateOpen });

  async function park(ready: () => boolean, nextAt?: number) {
    state.blocked = true;
    state.nextAt = nextAt;
    const wake = () => ready() || overLimit();
    if (nextAt === undefined) await condition(wake);
    else await condition(wake, Math.max(1, nextAt - Date.now()));
    state.blocked = false;
    state.nextAt = undefined;
    checkLimit();
  }

  async function close(status: "completed" | "failed") {
    state.status = status;
    state.blocked = true;
    state.nextAt = undefined;
    state.pending = [];
    for (const invocation of state.invocations)
      if (invocation.status === "pending") invocation.status = "obsolete";
    if (
      status === "failed" &&
      active &&
      !["completed", "stopped", "timed_out", "failed"].includes(
        active.run.status,
      )
    ) {
      active.run.status = "failed";
      active.run.error = limitFailure!.message;
    }
    trace(
      status === "failed" ? "error" : "completed",
      status === "failed"
        ? limitFailure!.message
        : "Conversation inactivity TTL expired",
    );
    const content = JSON.stringify(state);
    // Bounded chunks avoid putting a whole report into one Temporal Activity payload.
    for (let offset = 0, part = 0; offset < content.length; part++) {
      let end = Math.min(offset + 100_000, content.length);
      const last = content.charCodeAt(end - 1);
      if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
      await saveConversation({
        conversationId: state.id,
        temporalRunId: state.temporalRunId,
        part,
        content: content.slice(offset, end),
        final: end === content.length,
      });
      offset = end;
    }
  }

  async function invoke(
    callKind: InvocationState["callKind"],
    options: {
      agentVersion: string;
      timeoutMs: number;
      budget: number;
      resultSchema: Record<string, JsonValue>;
    },
    stepId?: string,
  ): Promise<JsonValue | undefined> {
    const current = active!;
    const callSite = `${callKind}:${stepId ?? "guard"}`;
    const attempt = (current.attempts.get(callSite) ?? 0) + 1;
    current.attempts.set(callSite, attempt);
    const invocation: InvocationState = {
      ...options,
      id: `${current.run.id}:${callSite}:${attempt}`,
      runId: current.run.id,
      conversationId: state.id,
      accountId: state.accountId,
      contactId: state.contactId,
      triggerEventId: current.event.eventId,
      workflowVersionId: current.version.id,
      callKind,
      stepId,
      attempt,
      revision: state.revision,
      status: "pending",
      input: {
        event: { ...current.event },
        history: state.events.map((event) => ({ ...event })),
        steps: { ...current.run.steps },
      },
    };
    state.invocations.push(invocation);
    current.run.status = "preparing";
    trace("invocation", `${callKind} ${callSite} attempt ${attempt}`);
    let finished = false;
    pendingAgents.set(invocation.id, Date.now() + options.timeoutMs);
    const { executeAgent } = proxyActivities<Activities>({
      startToCloseTimeout: options.timeoutMs,
      scheduleToCloseTimeout: options.timeoutMs,
      retry: { maximumAttempts: 1 },
    });
    // Keep obsolete calls observable; logical cancellation does not promise provider cancellation.
    void executeAgent({ sandboxId: state.sandboxId, invocation }).then(
      (result) => {
        pendingAgents.delete(invocation.id);
        invocation.result = result;
        invocation.completedAt = Date.now();
        finished = true;
        if (invocation.status === "obsolete")
          trace("obsolete_result", invocation.id, current.run.id);
      },
      (error: unknown) => {
        pendingAgents.delete(invocation.id);
        invocation.completedAt = Date.now();
        const cause =
          error instanceof ActivityFailure && error.cause instanceof Error
            ? error.cause
            : error;
        const timedOut = cause instanceof TimeoutFailure;
        invocation.error = timedOut
          ? "Invocation timed out"
          : cause instanceof Error
            ? cause.message || "Agent invocation failed"
            : String(cause);
        if (invocation.status !== "obsolete")
          invocation.status = timedOut ? "timed_out" : "failed";
        finished = true;
        if (invocation.status === "obsolete")
          trace("obsolete_result", invocation.id, current.run.id);
      },
    );
    await park(
      () =>
        finished ||
        state.revision !== invocation.revision ||
        isStopped(current.run),
      Date.now() + options.timeoutMs,
    );
    if (state.revision !== invocation.revision || isStopped(current.run)) {
      invocation.status = "obsolete";
      trace("obsolete", invocation.id, current.run.id);
      return undefined;
    }
    if (!finished) {
      invocation.status = "timed_out";
      invocation.error = "Invocation timed out";
    }
    if (invocation.error !== undefined) {
      current.run.status =
        invocation.status === "timed_out" ? "timed_out" : "failed";
      current.run.error = invocation.error;
      paused = true;
      trace("error", invocation.error);
      return undefined;
    }
    invocation.status = "accepted";
    current.run.status = "running";
    trace("accepted_result", invocation.id);
    return invocation.result;
  }

  try {
    for (;;) {
      checkLimit();
      state.blocked = false;
      state.nextAt = undefined;
      if (
        active &&
        ["completed", "stopped", "timed_out", "failed"].includes(
          active.run.status,
        )
      )
        active = undefined;
      if (paused || (!active && state.pending.length === 0)) {
        const revision = state.revision;
        const configuration = configurationRevision;
        const lifecycle = lifecycleEnabled();
        const pending = lifecycle ? pendingAgents.size : 0;
        const expiring = lifecycle && !paused && pending === 0;
        if (expiring) {
          buffered = [];
          idleSince ??= Date.now();
        }
        const deadline = expiring
          ? idleSince! + limits.idleTimeoutMs
          : pending
            ? Math.min(...pendingAgents.values())
            : undefined;
        await park(
          () =>
            state.revision !== revision ||
            configurationRevision !== configuration ||
            (lifecycle && pendingAgents.size !== pending),
          deadline,
        );
        if (
          expiring &&
          state.revision === revision &&
          configurationRevision === configuration &&
          Date.now() >= deadline!
        ) {
          await close("completed");
          return;
        }
        continue;
      }
      idleSince = undefined;
      const currentStep = active?.version.definition.steps.find(
        (step) => step.id === active?.run.stepId,
      );
      if (buffered.length && currentStep?.kind !== "wait_message") {
        const due = Math.min(
          buffered[buffered.length - 1]! + 3000,
          buffered[0]! + 10000,
        );
        if (Date.now() < due) {
          const revision = state.revision;
          await park(() => state.revision !== revision, due);
          continue;
        }
        buffered = [];
      }
      if (!active) {
        const trigger = state.pending.shift()!;
        if (!enabled.has(trigger.workflowVersionId)) continue;
        const version = definitions.get(trigger.workflowVersionId)!;
        const event = state.events.find(
          (entry) => entry.eventId === trigger.triggerEventId,
        )!;
        const run: RunState = {
          id: `${state.id}:${lifecycleEnabled() ? `${state.temporalRunId}:` : ""}${state.runs.length + 1}`,
          conversationId: state.id,
          workflowVersionId: version.id,
          triggerEventId: event.eventId,
          stepId: version.definition.start,
          status: "running",
          steps: {},
        };
        state.runs.push(run);
        active = {
          run,
          version,
          event,
          cursor: state.events.indexOf(event) + 1,
          guardRevision: -1,
          timedOut: false,
          attempts: new Map(),
        };
        trace("started", version.key);
      }
      const current = active;
      const { run, version } = current;
      const guard = version.definition.guard;
      if (
        guard &&
        (current.guardRevision !== state.revision ||
          // Keep recorded commands compatible with histories that cached rule results.
          (guard.kind === "rule" && patched("rule-guard")))
      ) {
        const latest = state.events[state.events.length - 1]!;
        if (guard.kind === "rule") {
          if (
            evaluatePredicate(guard.predicate, {
              event: latest,
              steps: run.steps,
            })
          ) {
            stop();
            continue;
          }
        } else {
          const result = await invoke("classifier", {
            ...guard,
            resultSchema: { enum: ["continue", "stop"] },
          });
          if (result === undefined) continue;
          if (result === "stop") {
            stop();
            continue;
          }
        }
        current.guardRevision = state.revision;
      }
      const step = version.definition.steps.find(
        (entry) => entry.id === run.stepId,
      )!;
      try {
        switch (step.kind) {
          case "end":
            run.status = current.timedOut ? "timed_out" : "completed";
            trace(run.status, version.key);
            break;
          case "condition":
            run.stepId = evaluatePredicate(step, {
              event: current.event,
              steps: run.steps,
            })
              ? step.then
              : step.else;
            break;
          case "wait_message": {
            current.deadline ??= Date.now() + step.timeoutMs;
            let accepted = false;
            while (current.cursor < state.events.length) {
              const event = state.events[current.cursor++]!;
              // Judge input by acceptance time, even if preparing its reply crosses the deadline.
              if (
                event.kind !== "message" ||
                eventTimes.get(event.eventId)! >= current.deadline
              )
                continue;
              if (
                !evaluatePredicate(step.accept, { event, steps: run.steps })
              ) {
                trace("rejected", event.eventId);
                continue;
              }
              run.steps[step.id] = { text: event.text.trim() };
              run.stepId = step.next;
              current.deadline = undefined;
              run.status = "running";
              accepted = true;
              trace("captured", step.id);
              break;
            }
            if (accepted) break;
            if (Date.now() >= current.deadline!) {
              run.stepId = step.onTimeout;
              current.deadline = undefined;
              current.timedOut = true;
              trace("timeout", step.id);
              break;
            }
            buffered = [];
            run.status = "waiting";
            const revision = state.revision;
            await park(() => state.revision !== revision, current.deadline);
            break;
          }
          case "agent_call": {
            const result = await invoke("agent", step, step.id);
            if (result !== undefined) {
              run.steps[step.id] = result;
              run.stepId = step.next;
            }
            break;
          }
          case "reply_comment":
          case "send_message": {
            const action: ActionRecord = {
              id: `${run.id}:${step.id}`,
              sandboxId: state.sandboxId,
              conversationId: state.id,
              runId: run.id,
              accountId: state.accountId,
              contactId: state.contactId,
              channel: step.kind === "reply_comment" ? "comment" : "message",
              commentId:
                step.kind === "reply_comment"
                  ? current.event.commentId
                  : undefined,
              text: renderText(step.text, {
                event: current.event,
                steps: run.steps,
              }),
              status: "committed",
            };
            state.actions.push(action);
            run.status = "sending";
            trace("committed", action.text);
            // Scheduling this Activity commits its immutable payload, even if stop arrives next.
            try {
              Object.assign(action, await sendMessage(action));
            } catch (error) {
              action.status = "unknown";
              throw error;
            }
            trace("delivered", `${action.channel}: ${action.text}`, run.id);
            if (!isStopped(run)) {
              run.stepId = step.next;
              run.status = "running";
            }
            break;
          }
        }
      } catch (error) {
        if (limitFailure) throw error;
        if (!isStopped(run)) {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : String(error);
          paused = true;
          trace("error", run.error);
        }
      }
    }
  } catch (error) {
    if (!limitFailure) throw error;
    await close("failed");
    throw limitFailure;
  }
}
