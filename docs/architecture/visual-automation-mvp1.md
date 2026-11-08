# Visual Automation MVP 1: architecture contract

Status: Proposed execution contract; layer 1 exists in the current worktree, layer 2 is not implemented. Lead and engineering review pending. Date: 2026-11-08.

## Layer 1: definition metadata

The current worktree adds PostgreSQL definition and revision tables and API routes. A definition has an immutable scope and a current revision; revision 1 is created inactive. Updates require `expectedRevision`, lock the definition row, append the next revision and advance the current pointer; stale writes return 409. Database triggers prevent revision update/deletion and guard pointer advancement. The API accepts only schema version 1, trigger `receipt.v1` and action `record-receipt.v1`. The current list endpoint returns at most 100 current definitions for a scope. See [definition routes](../../backend/src/automations.ts), [migration](../../backend/migrations/004_automation_definitions.sql), and [backend README](../../backend/README.md#automation-definitions-layer-1) for details and limitations.

These are code observations, not a claim that the local changes have passed tests or review. No event matching or automation execution is implemented by layer 1. Scope is caller-supplied and is not a security boundary.

## Layer 2: required future behavior

1. **Acceptance:** In the same transaction as a newly accepted event and its outbox record, select the current active revisions where definition scope equals event scope and trigger type equals event type, using exact equality. Persist the complete selected set and its revision references atomically. Selection must use one coherent database snapshot. No selected definitions is a valid empty snapshot.
2. **Concurrency and replay:** A definition revision committed and visible at the selection snapshot is eligible; a concurrent revision not visible then is not. A deactivation after that point does not cancel selected work. A duplicate idempotent acceptance returns the original event and snapshot without adding executions; a conflicting request retains the existing conflict behavior. The snapshot must be durable before acceptance is reported successful.
3. **Identity and execution:** Enforce one execution per `(event_id, automation_id)` in PostgreSQL and pin it to the selected immutable `(automation_id, revision)`. Execute the pinned `record-receipt.v1` action deterministically inside the existing event worker transaction. All selected action effects and the successful event disposition commit together; a failure must not leave partial action effects committed. The exact receipt representation and coexistence with the existing event receipt remain to be specified and reviewed; do not assume one receipt per automation already exists.
4. **Failure and status:** An unknown action version fails closed; it must not be treated as success. Apply the existing event-scoped retry/disposition machinery rather than inventing independent execution retries. Execution status is derived from the parent event state; no separate status transition is implied. Exact status projection and unknown-version disposition require implementation review. No cancellation or backfill is provided.
5. **Transport:** Continue using the existing RabbitMQ/outbox publication and retry flow; acknowledge delivery only after the relevant database commit. Redelivery must not duplicate committed internal executions. This is not an exactly-once guarantee for delivery or external side effects.

## Deployment compatibility

Definition metadata alone does not change worker behavior. Before enabling layer 2 acceptance snapshots, prevent old workers from consuming and acknowledging any affected event; mixed old/new consumers without fencing are unsafe. Plan and verify schema deployment, worker cutover, in-flight and queued legacy events, feature enablement and rollback together. Events accepted before enablement are not retroactively matched. The implementation has not yet selected a fencing mechanism or legacy-event marker; compatibility is an open rollout prerequisite, not an implemented guarantee.

## Evidence and open verification

- Existing acceptance: [accept.ts](../../backend/src/accept.ts); processing and ACK behavior: [worker.ts](../../backend/src/worker.ts); publication/retry: [relay.ts](../../backend/src/relay.ts), [scheduler.ts](../../backend/src/scheduler.ts), and [backend README](../../backend/README.md).
- Definition storage and interface: [migration 004](../../backend/migrations/004_automation_definitions.sql), [routes](../../backend/src/automations.ts), and [schema](../../backend/schemas/automation-v1.schema.json).
- [ADR 0001](../adr/0001-visual-automation-mvp1.md) records the proposed decision and tradeoffs. The detailed execution schema, status mapping, concurrency implementation, cutover/fencing and failure tests remain unspecified and unverified. An independent technical and operational review is required before enablement.
