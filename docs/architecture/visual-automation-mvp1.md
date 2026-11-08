# Visual Automation MVP 1: architecture contract

Status: MVP contract accepted by Lead; implementation in the current worktree is a local proof, not approved for production deployment. Date: 2026-11-08.

## Layer 1: definition metadata

The backend has definition and immutable revision tables and API routes. A definition has an immutable scope and a current revision; revision 1 is inactive. Updates require `expectedRevision`, lock the definition row, append the next revision and advance the current pointer; stale writes return 409. Database triggers guard revisions and pointer advancement. The API accepts schema version 1, trigger `receipt.v1` and action `record-receipt.v1`. The list endpoint returns at most 100 current definitions for a scope. See [definition routes](../../backend/src/automations.ts) and [migration 004](../../backend/migrations/004_automation_definitions.sql). Scope is caller-supplied, not an authorization boundary.

## Layer 2: acceptance and execution

- **Snapshot:** When the default-off snapshot gate is explicitly enabled, a newly accepted event's transaction inserts an event automation context and selects current active revisions with exactly matching scope and `receipt.v1` trigger in one SQL statement. It persists selected executions alongside the event and outbox. An empty selection is valid. A concurrent revision is eligible only if visible to the selection statement; request start and response order do not decide the race. Deactivation does not cancel a selection already made. With the gate disabled, acceptance preserves legacy behavior and creates no automation context or execution rows.
- **Replay and identity:** A duplicate idempotent acceptance returns the existing event without rematching; a conflicting payload retains the existing conflict behavior. [Migration 005](../../backend/migrations/005_automation_executions.sql) enforces one execution per `(event_id, automation_id)` and references the immutable selected revision. Previously accepted events are not backfilled.
- **Processing:** The worker locks the event, checks all selected versions and fails closed with an `unknown` outcome if any is unsupported. On success, it writes the same deterministic `{kind: "local-receipt.v1", eventId, message}` result to the existing event receipt and each selected execution. Those writes and the event disposition commit in one event-scoped transaction; a transaction failure cannot commit partial results. Event-level retry/disposition applies to the whole set, not independent execution retry. Delivery is acknowledged after commit. This protects internal state, not exactly-once delivery or exactly-once external effects.

## Execution query contract

`GET /executions/:id` returns an execution or 404. `GET /executions` requires exactly one lowercase UUID filter, `eventId` or `automationId`; it returns `{items}` ordered by execution ID, limited to 100, with no pagination. Unknown query properties and invalid filters are rejected. See [routes](../../backend/src/executions.ts) and the [execution schema](../../backend/schemas/execution-v1.schema.json) for fields and validation.

Status and retry data are derived from the parent event, not a separate execution lifecycle: `retry_released` takes precedence when the current retry publication exists and is unprocessed; otherwise the disposition state is used, or `completed` if a result exists, or `accepted`. The disposition states include `retry_scheduled`, `completed` and `blocked`. The result is null until success. During `retry_released`, the generation is the newly released generation while other retry details describe the preceding disposition. Authentication, authorization, tenant isolation, pagination and independent execution retry are not implemented.

## Deployment compatibility and rollback

Snapshot creation is controlled by the default-off `AUTOMATION_SNAPSHOTS_ENABLED` gate. Only exact `true` enables matching; unset or exact `false` disables it, and malformed values fail API startup. This gate does not coordinate deployment or fence consumers. An old worker can acknowledge a snapshotted event without executing its automation, so mixed old/new workers remain unsafe when snapshots are enabled. Do not treat the gate alone as a production cutover procedure.

Before any enablement, operations and engineering must review and test a concrete protocol that:

1. Verifies the default-off gate, applies compatible schema, inventories all consumers and legacy in-flight/queued events, and establishes a legacy-event handling policy. Existing events are not retroactively matched.
2. Stops or fences every old worker, accounts for in-flight deliveries, installs compatible workers, and verifies that old consumers cannot resume or consume the queue before enabling snapshots. Validate schema, worker readiness and the gate before enablement.
3. For rollback, disable snapshot creation first and verify it is disabled. Keep compatible workers and schema available until all events accepted with snapshots, including queued, in-flight, retrying and blocked work, are accounted for and safely resolved under an approved procedure. Do not restore old workers while any such event can be delivered. Only then consider a worker rollback; preserve the schema and pinned revisions while referenced work or records remain. Escalate unresolved work rather than silently discarding it.

Consumer fencing/coordination, inventory and drain criteria, handling of blocked work, verification steps, owners and rollback execution remain unimplemented and require operational review and rehearsal. This is a required protocol outline, not a tested runbook or production deployment approval.

## Evidence and verification limits

- [Acceptance](../../backend/src/accept.ts), [worker and acknowledgement](../../backend/src/worker.ts), [migration 005](../../backend/migrations/005_automation_executions.sql), [query routes](../../backend/src/executions.ts), [relay](../../backend/src/relay.ts) and [scheduler](../../backend/src/scheduler.ts) are the implementation evidence.
- [ADR 0001](../adr/0001-visual-automation-mvp1.md) records the accepted MVP decision and tradeoffs. [Backend README](../../backend/README.md) describes the local profile.
- These observations are not test results. The configuration gate has implementation evidence, but cutover, consumer fencing and rollback remain operationally unverified; independent technical and operational review is required before production enablement.
