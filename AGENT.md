# Agent guidance

Read [README.md](README.md) and the [architecture decision](adr/0001-automation-design.md)
before changing behavior. Use English for code, comments, UI text, and documentation.

## Scope

- Implement the requested behavior and preserve the agreed architecture.
- Let Temporal own execution, timers, and retries; do not add a second SQL workflow scheduler.
- Solve the concrete problem before adding extension points or configuration.
- Add dependencies, layers, and infrastructure only for a demonstrated current need.
- Keep deferred features deferred. Agent execution stays abstract; MCP is a future adapter.
- Fix defects against agreed behavior without reopening settled product decisions.
- Keep documentation short. Put architectural reasons in ADRs.

## Edge cases

- Confirm unagreed edge-case behavior with the user before implementing it.
- Describe the concrete situation, its impact, and the simplest reasonable behavior.
- Separate a reproducible problem from a hypothetical future possibility.
- Do not add fallback chains, retries, recovery policies, or new states for speculation.
- Preserve accepted guarantees such as deduplication and rejecting stale agent results.
- Reuse prior decisions; batch related questions and continue independent work while waiting.
- Waiting for a reply is not approval. Leave dependent behavior unchanged until answered.

## Naming

- Reuse the approved naming map and existing domain vocabulary.
- Routine private local names may be chosen from that vocabulary without another approval.
- Confirm new domain/public names and changes to approved terminology, files, APIs, or tables.
- Apply approved names consistently; do not invent synonyms for the same concept.
- Propose related naming additions together and reuse prior approvals.

## Code style

- Use strict TypeScript and runtime validation at external boundaries.
- Prefer ordinary functions, explicit dependencies, and small cohesive modules.
- Use named exports and direct imports; keep implementation helpers local.
- Model variants with discriminated unions and handle them explicitly.
- Type exported boundaries; let TypeScript infer obvious local values.
- Avoid assertions used to silence type errors, generic base classes, and redundant wrappers.
- Use classes for meaningful state or lifecycle, and interfaces for real replacement needs.
- Give every promise an owner. Run independent work concurrently and ordered work sequentially.
- Treat waits, duplicate events, and stale results as normal outcomes.
- Catch errors to handle them or add context; preserve the cause and log at the owning boundary.

## Comments

Comment non-obvious reasons, invariants, and external constraints.
Aim for roughly 10-20 useful comments across the implementation; this is not a quota.
Avoid narrating obvious code, repeating types in JSDoc, and decorative section dividers.
Comments must describe guarantees the code actually implements.
Keep long explanations in the documentation.
Leave `// TODO: allow mcp` beside workflow management operations when implemented.

## Review

Review the change and affected user path against the agreed scope, README, ADR, and this guide.

- Complexity: unnecessary abstractions, dependencies, configuration, duplicated logic,
  speculative recovery paths, and implementation of deferred features.
- Correctness: accepted behavior, account boundaries, transactional changes, duplicate events,
  concurrent execution, stale results, and consistency between normal runs and backtests.
- Missing edge cases: identify a concrete scenario and its impact. If its behavior is unagreed,
  ask the user before implementing a policy; reuse decisions already confirmed.
- Style: clear code, approved naming, explicit dependencies, and sparse, truthful comments.
- Verification: checks demonstrate behavior and important failure paths; mocks do not conceal
  persistence or concurrency problems. Avoid tests that merely mirror the implementation.
- Cost: flag demonstrated unnecessary queries, model calls, or unbounded work in the changed path.
  Hypothetical future load alone does not justify new infrastructure.

For each finding, give the location, scenario, expected versus actual behavior, and impact.
Separate defects, decisions needing user confirmation, and optional suggestions.
Fix defects within agreed behavior; batch unresolved edge cases and naming questions for the user.
Keep suggested fixes minimal. Cosmetic preferences and speculative features must not block delivery.

## Verification and delivery

- Check observable behavior and important boundaries rather than implementation details.
- Verify execution ordering and recovery against Temporal and business-record persistence against PostgreSQL.
- Use real services where mocks cannot establish the required guarantees.
- Run checks relevant to the change and report their actual results.
- Respect `.gitignore`; keep `task.md` and local working material out of commits.
