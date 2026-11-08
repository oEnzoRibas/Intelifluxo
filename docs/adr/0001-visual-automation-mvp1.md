# ADR 0001: Visual Automation MVP 1 execution boundary

- Status: Accepted by Lead for the MVP contract; not an approval for production deployment
- Date: 2026-11-08
- Scope: Visual Automation MVP 1

## Context and evidence

The local backend accepts `receipt.v1` events into PostgreSQL with an outbox, and its worker records a deterministic local receipt before acknowledging a RabbitMQ delivery. The existing retry path persists dispositions and uses bounded scheduler and relay sweeps. The current worktree also implements acceptance snapshots and automation execution records; these are local-proof capabilities, not production guarantees. See [the architecture contract](../architecture/visual-automation-mvp1.md) and its evidence links.

## Decision

Keep PostgreSQL as the authority and extend the existing acceptance and worker transactions, not a parallel workflow engine. When the default-off snapshot gate is explicitly enabled, first acceptance atomically snapshots all current, active definitions whose scope and trigger exactly match the event; with the gate disabled, acceptance creates no automation execution records. Each selected automation yields one execution identified uniquely by `(event_id, automation_id)`, pinned to the selected immutable revision. A replay of the same accepted event reuses its original snapshot; it must not rematch. The only MVP trigger is `receipt.v1`; the only action is the deterministic, internal `record-receipt.v1`. Unknown action versions fail closed, never silently succeed or fall back.

All selected executions for an event and the existing event processing disposition belong to one worker database transaction. An action failure rolls back the event-scoped action effects; retry or blocked state follows the existing event-level disposition policy. Execution status is derived from the parent event rather than an independent execution lifecycle. RabbitMQ, transactional outbox, retry flow and acknowledgement after commit remain in use. The database uniqueness and transaction boundaries protect internal state; they do **not** establish exactly-once delivery or exactly-once external effects.

Definitions have immutable, monotonically increasing revisions. Editing, activating or deactivating creates a revision. Deactivation affects future acceptance snapshots only: it does not cancel already selected work. MVP has no cancellation or backfill. Matching has a single database snapshot/linearization point: a concurrent definition commit visible to that snapshot is included; one not visible is not. Concurrent edits and acceptance need not be ordered by request start time or response time. The implementation must make selection coherent across the entire set, not issue independent reads that can observe different snapshots.

## Consequences and tradeoffs

- Pinned revisions make retries reproducible despite later edits, but revision and execution retention become dependencies of processing and audit.
- Event-level atomicity is simple and avoids partial internal results, but one failing action delays all selected executions and large match sets increase transaction cost. No limit or performance guarantee is established here.
- A single parent status avoids inconsistent independent states but cannot describe per-action progress. No external side effect may be inferred from an internal receipt.
- Snapshot-at-acceptance makes the acceptance/update race explicit; it intentionally does not guarantee that an overlapping deactivation wins.
- Scope is matching data, not authorization. The current local proof has no authentication or tenant isolation.

## Alternatives and migration

Matching at worker time was rejected because edits or retries could change the selected work. Independent per-automation transactions and a separate orchestration engine were rejected for MVP because they introduce partial completion, coordination and operational complexity. An external action is deferred because database atomicity cannot guarantee its exactly-once effect.

Layer 2 uses the default-off `AUTOMATION_SNAPSHOTS_ENABLED` acceptance gate and still requires a coordinated, verified cutover and rollback protocol as described in the [architecture contract](../architecture/visual-automation-mvp1.md#deployment-compatibility-and-rollback). The gate does not provide deployment automation or consumer fencing. Merely deploying new workers alongside old workers is unsafe: an old worker can acknowledge an event without executing its snapshot. Do not enable snapshot creation in a mixed-worker environment; existing accepted events are not backfilled. Production rollout requires separate operational approval and evidence.

Future versions may add action types, external effects or independently progressing executions only through explicit versioned contracts, migration and operational decisions. External effects need their own idempotency and recovery design; retaining old action-version handlers or a deliberate migration is necessary for pinned outstanding work.
