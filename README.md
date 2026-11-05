# Workflow automation

```sh
docker compose up --build -d
```

Open http://localhost:8080.

## Architecture

- Self-hosted Temporal owns orchestration, durable waits, retries, and execution history. This avoids building another scheduler and recovery mechanism in application code.
- One interpreter executes typed workflow steps for normal runs and backtests.
- Agent calls and social sends use an `Activities` contract with controlled mock and HTTP implementations. The HTTP implementation calls a separate fake service in this demo; real integrations would implement this boundary.

## Data model

- A workflow is an immutable, versioned JSON graph of conditions, waits, comment replies, DMs, agent calls, and end steps. Restricted YAML is converted to JSON and validated on upload.
- A conversation belongs to a sandbox, account, and contact. Each business run pins its workflow version, so editing a definition does not change an active run.
- Events use a common comment/message format and retain the provider identifiers needed for deduplication and reply targeting. Platform adapters would normalize incoming payloads.
- PostgreSQL stores definitions, sandbox metadata, conversation identities, delivery receipts, and backtest reports. Temporal owns execution state in its own persistence.

## Execution model

1. An incoming event reaches its conversation through a short Temporal Update. The receipt confirms that input was applied; subsequent steps may still be running.
2. Matching triggers enter a FIFO queue. One business run executes at a time per conversation.
3. The interpreter advances through steps, schedules external work as Activities, and suspends on waits. Waiting does not reserve a worker slot; later input or a durable timer resumes work.
4. Backtests feed recorded or scripted events and agent results into a fresh sandbox with controlled time and mock Activities. To try another continuation, replay the prefix and change the remaining timeline.

The pricing example is: comment -> public reply -> DM asking for email -> wait for a valid email -> DM with a link. Normal mode uses the persistent Temporal service and separate workers. The default accelerated demo uses isolated time-skipping environments and controlled results.

## Reliability

- Normal execution survives worker and API restarts. Accelerated sandbox state lasts for the owning API process; saved PostgreSQL reports survive restarts.
- External sends are at least once. An Activity can be retried after an uncertain outcome. Sends have stable action IDs; real providers need idempotency or reconciliation.
- Duplicate input event IDs do not start another run or repeat a delivery within a conversation.
- Scheduling a send Activity commits its payload. Later input or stop cannot reliably cancel that send. Completed steps remain completed.
- Terminal execution failures pause pending runs until an explicit stop clears the backlog. Message waits follow their declared timeout branch. Agent calls have bounded deadlines.

## Concurrency

- **Messages from one contact:** preparation normally waits for three seconds of silence, capped at ten seconds from the first buffered input. New input changes the context revision; obsolete agent results cannot advance the run or send.
- **Multiple triggers from one contact:** finish the active run first, then process pending triggers in acceptance order. Other contacts have independent conversation coordinators.
- **Peak activity on one workflow definition:** executions share an immutable definition, not a single execution lock. Temporal queues buffer work and worker replicas consume it. Production also needs provider rate limits and quotas.

## Extensibility

From my experience, as soon as users get access to cheap message sending/reaction to users, they want to engage with all users that could have any change of paying them. Also, workflow logic you've described as an example would not be viable, i expect people would want to use Jev/your provided Jev-like model for decision making (price, decision latency). This may be overcomplication at the moment, but i believe with agents ordinary people would start to make complex workflows with multi-block logic, decision, action agents and so on.

## AI disclosure

- **Coding:** All code was written by Codex. I do not believe in writing code manually in startups anymore. If this is a problem for you, I am not a good fit for your company.
- **My decisions:**
    - Assumptions, scope and future directions for growth
    - Architecture (including Temporal)
    - Workflow format, extensiblity
    - Interpreter & simulations
    - Conversation ordering
    - Interruptions logic
- **AI contribution:** options research, implementation, verification, code review using to my agent skill.
