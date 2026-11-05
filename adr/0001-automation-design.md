# Use Temporal for durable workflow execution

Status: accepted.

## Context

Customer workflows react to social events, perform actions, and wait for later input.
Execution must survive worker restarts and handle new messages during agent preparation.
Users also need controlled simulations with recorded effects and accelerated time.

The application needs durable waits, retries, message delivery, and execution history.
Temporal supplies these execution mechanisms while keeping infrastructure self-hosted.

## Decision

Use a TypeScript API and Temporal workers sharing application code.
Run Temporal as a self-hosted service with its own persistence database.
Use PostgreSQL for workflow definitions, business records, simulation metadata, and reports.
Application code does not read or modify Temporal's internal database tables.

Temporal owns execution progress, pending work, durable timers, and Activity scheduling.
Application PostgreSQL records may project that state for display and reporting.
A second SQL state machine or PostgreSQL job queue must not also own execution.

### Workflow representation

Keep validated canonical JSON and restricted YAML import.
Publish immutable definition versions and pin each business run to its selected version.
A Temporal Workflow interprets the definition through explicit step handlers.
Customers upload data; they do not supply executable Temporal code.

Use one Temporal Workflow to coordinate a conversation within its account and sandbox.
It owns the active business run, buffered input, pending triggers, and context revision.
A business run is one execution of a customer definition, distinct from a Temporal Run ID.
Completing or stopping a business run does not terminate the conversation coordinator.

### Interpreter compatibility

An immutable definition version pins customer data, not interpreter code.
Workflow code must remain compatible with recorded Temporal commands during replay.
Use Temporal patches for replay-incompatible changes and replay recorded histories before rollout.
Keep old command paths until affected executions no longer require them; retire patches through
Temporal's deprecation process. The demo uses `patched("rule-guard")` and `patched("conversation-lifecycle")`;
versioned Worker Deployments are not configured.
An inactivity TTL does not replace versioning: active executions can outlive it.

### Input and state ownership

Deliver validated input through short synchronous Temporal Updates.
Acknowledge after the input handler applies the input; downstream steps may still be running.
Deduplicate by provider event identity within the connected account and simulation context.
Keep state-changing handlers short; the main Workflow advances steps and schedules Activities.

PostgreSQL writes and Temporal message acceptance do not share a transaction.
Do not treat a business-record write as proof that execution has advanced.
Update SQL projections idempotently and read authoritative execution state from Temporal.

### External work and sending

Perform database I/O, agent calls, and social sends in Activities.
Workflow code uses deterministic logic and Temporal time primitives.
Keep agent execution behind a versioned JSON input/output contract.
The adapter owns search and reasoning; the Workflow decides whether a result is applicable.

Declare an explicit Activity contract with controlled and HTTP implementations.
Normal workers call a separate local fake service through HTTP; simulations register
controlled Activities. Select implementations at worker startup and share result validation.
The fake exercises the service boundary using our own protocol, not a provider emulation.
Record observed invocation completion timing in the Workflow so HTTP results remain replayable.

New input may supersede current preparation; reject results for an obsolete context revision.
Before entering a send step, validate the current result and freeze the outgoing payload.
The cutoff is the durable Temporal decision scheduling its send Activity.
Once committed, later messages or a domain stop do not retract that send.
Completed steps remain completed; there is no general workflow rewind.

A domain stop clears future preparation and pending triggers.
Buffered input preceding that stop must not restart cancelled work.
Genuinely new later input can start another business run.
A committed send may still finish; stop is a domain operation, not Workflow termination.

Use at-least-once retry semantics for social sends, accepting possible duplicate effects.
The demo allows three send attempts with the same action ID and frozen payload.
HTTP errors, transport failures, and invalid receipts are retryable; the adapter does not
distinguish a definite rejection from an accepted send whose response was lost.
A valid receipt completes the action. On terminal send failure, mark the action `unknown`;
an active business run fails and pauses pending work until a domain stop clears it.
A stable action ID enables deduplication only if the receiver implements it.
Provider idempotency or reconciliation can reduce duplicates but is not required for retries.
Without either capability, retries can produce duplicates; reconciliation is not implemented.
The three-attempt limit bounds retries and does not guarantee a successful external delivery.

### Simulation

Execute the same interpreter as a Temporal Workflow with mocked Activities.
Use isolated time-skipping test environments for accelerated sandboxes and backtests.
A test environment's clock is shared: isolate independent simulations from each other.
Use manual advancement and retain the requested cutoff instead of skipping to completion.
Export traces and reports before disposing of a simulation environment.

The normal Temporal service retains its normal clock and persistence.
Test-server history replay checks code compatibility; product backtests feed new timelines.
A backtest still needs its input script, controlled results, assertions, and report.
The UI's time controls apply only to its isolated simulation environment.

### History and retention

Coordinator limits are pinned in its start input: a 24-hour inactivity TTL, 10,000 history
events, and 20 MiB of history. Changing defaults affects fresh coordinators.
Each business run keeps its original immutable definition, including agent and wait settings.

- Complete an idle coordinator after its inactivity TTL, once its active run, pending triggers,
  buffered input, Activities, and message handlers have drained. Waiting for customer input
  is active work and retains its declared deadline.
- Enforce a history limit for coordinators that remain active. Exceeding it fails the coordinator
  without automatic retry or restart. New input cannot resume it; an explicit restart is required.
  Persist this stop in application storage so history cleanup cannot remove the restart requirement.
  Do not start further work after the limit is reached; committed sends may still complete.
- Save reports needed beyond Temporal retention in application storage before closing.
  Preserve unique business-run and action IDs across fresh starts after TTL or explicit restarts.
  Do not derive IDs from the length of a reset run array.
- Keep event deduplication keys and delivery receipts across closures and restarts for the
  supported provider retry and replay window. A deduplication record alone must not acknowledge
  input that execution has not applied.

Temporal namespace retention cleans up closed executions; it does not expire open ones.
Coordinator rotation with Continue-As-New and automatic state migration are excluded.
Archive snapshots through bounded, idempotent Activities. Final archival, applied-event keys
and the persistent stop commit together. Input acceptance holds the same conversation row lock
through its Temporal Update acknowledgement. Release that lock before waiting for closure.
Reports combine archived generations; fresh coordinators receive fresh working context.

## Consequences

Temporal provides durable orchestration and execution history.
Application code still defines routing, guards, deduplication, and the send commitment rule.
API, Workflow workers, and Activity workers can be deployed and scaled independently.

Self-hosting adds service maintenance, persistence, monitoring, and SDK deployment rules.
Keep Workflow histories bounded and preserve deterministic code compatibility across updates.
A lightweight development server is not a production persistence configuration.

Test restart/recovery against the normal Temporal service and PostgreSQL.
Use time-skipping environments for accelerated timing cases, not as proof of SQL durability.

## References

[Message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing),
[Versioning](https://docs.temporal.io/develop/typescript/workflows/versioning),
[Retention](https://docs.temporal.io/temporal-service/temporal-server#what-is-a-retention-period),
[Activities](https://docs.temporal.io/activities), and
[Workflow testing](https://docs.temporal.io/develop/typescript/best-practices/testing-suite).
[Self-hosting](https://docs.temporal.io/self-hosted-guide/production-checklist)
covers the production operating responsibilities.
