# ADR 0006: No-terminal local app workflow

- Status: **Accepted by Lead for the local controlled v0.1.0 slice**; not deployment, gate enablement or production-use approval
- Date: 2026-11-12
- Implementation and evidence update: 2026-11-13
- Scope: local launcher, persistent runtime and scope-wide test-event workflow
- Predecessors: [0004](0004-automation-list-dashboard.md), [0005](0005-viacep-address-lookup.md)

## Context and evidence

An ordinary user must open an app shortcut/launcher and use the local app without opening a terminal or manually running relay/scheduler sweeps. A developer command may invoke the same supervisor; terminal-only startup does not satisfy acceptance. Existing PostgreSQL and RabbitMQ remain infrastructure, not components to recreate or embed in the API.

Source evidence for the decision and current implementation:

- [relay-main.ts](../../backend/src/relay-main.ts) and [scheduler-main.ts](../../backend/src/scheduler-main.ts) route through the shared role entrypoint. Legacy scripts default to one sweep; daemon scripts repeat sweeps. [relay.ts](../../backend/src/relay.ts) exposes `relayOnce`, reading at most 100 initial and 100 retry publications per sweep. [scheduler.ts](../../backend/src/scheduler.ts) exposes `scheduleOnce`, with a validated limit of 1-100 and transactional eligibility checks.
- [api.ts](../../backend/src/api.ts) provides `POST /events`, `GET /events/:id` and a static `/status` limitations response, not runtime readiness. Acceptance returns 202 for new acceptance, 200 for replay and 409 for an idempotency conflict.
- [executions.ts](../../backend/src/executions.ts) provides strict filtered `GET /executions`: exactly one of `eventId` or `automationId`, a maximum of 100 results ordered by execution ID. This is not a complete newest-first history feed.
- [contract.ts](../../backend/src/contract.ts) restricts event scope to 1–64 ASCII letters, digits, underscores and hyphens. [automations.ts](../../backend/src/automations.ts) accepts broader text scopes up to 128 characters. These are incompatible acceptance domains.
- Backend/frontend package scripts expose development commands and Prettier checks; their existence is not evidence of a no-terminal packaged runtime.

This ADR preserves the supplied Lead-approved decision; implementation is partial, as classified below. Launcher packaging, infrastructure prerequisites, supported operating systems, operational timing approval and runtime-status wire schema still require review. No operational throughput, latency or availability guarantee is inferred.

## Implementation status and evidence — 2026-11-13

**Partial implementation, not acceptance of the no-terminal workflow.** The decision sections remain the target, not a claim that all requirements are implemented. The composed supervisor and launchers provide a controlled local runtime slice, but not the required runtime-status submission gate or an approved complete launch experience.

### Runtime components and policies

- `backend/src/runtime-role.ts` and `runtime-loop.ts` implement a serial role lifecycle: one in-flight sweep, disposal before another, and bounded jittered infrastructure retry without changing persisted business retry eligibility. `runtime-lock.ts` uses dedicated PostgreSQL session advisory locks for relay `(1229342284, 1)` and scheduler `(1229342284, 2)`, with automatic bounded heartbeats. Contention admits no sweep; lock loss stops admission and cancels owned work. The lock session is not pooled.
- `runtime-resources.ts`, `runtime-relay.ts` and `runtime-scheduler.ts` use fresh disposable PostgreSQL resources per sweep and, for relay, fresh AMQP connection and confirm channel. They enforce operation and cleanup deadlines, cancellation and terminal error normalization/redaction. The restricted confirm-channel facade serializes admitted operations and requires persistent, mandatory publication with confirm and return handling; relay also probes conformance. Driver-specific transport destruction depends on pinned `pg` and `amqplib` internals and needs revalidation on upgrades.
- If cleanup cannot be proven settled, `CLEANUP_STUCK` retains any owned lock rather than releasing it while work may still run. The entrypoint must hard-terminate the process (exit 6); this is not a normal recoverable loop exit. Lock loss does not fence in-flight RabbitMQ publication: at-least-once delivery and duplicate safety remain necessary, not exactly-once delivery or Rabbit fencing.
- Backend scripts `relay` and `scheduler` are one-shot through the same ownership lifecycle as `relay:daemon` and `scheduler:daemon`. The executable validates role and mode before dynamic import and emits sanitized boundary failures, not raw configuration or exception data. Exit codes: **0** success or stopped; **2** busy; **3** retryable acquisition or one-shot failure; **4** fatal; **5** lock lost; **6** cleanup stuck. First SIGINT/SIGTERM stops admission and allows bounded drain; the second forces cancellation.
- **IPC prerequisite implemented:** `runtime-executable.ts` accepts literal parent messages `shutdown` and `force` and queues controls received during dynamic import until handlers exist. IPC `shutdown` and disconnect request graceful shutdown idempotently and cannot escalate; IPC `force` is explicit. OS signals have a separate count. Fake/unit tests and a bounded real subprocess test provide the evidence described below; this is not proof of real parent-death handling. API, worker and frontend parent-death handling remains absent. The IPC control fix was reviewed; `control_failed` reports an IPC failure and no longer claims the child stopped.
- The composed supervisor combines a best-effort loopback singleton, managed-infrastructure or `--no-infra` bootstrap, authenticated dependency preflight, migration via direct Node invocation, and a five-child manager with finite restart budget, readiness checks and allowlisted lifecycle events. The CMD and PowerShell launchers invoke it. A verified duplicate can reuse the existing instance; configured ports are strict, with no alternate-port fallback. Feature gates remain default-off. These internal readiness checks do not implement `/runtime/status` or the UI submission gate.
- Fixed-port HTTP readiness responses and the cooperative singleton can be spoofed by a hostile local process; they do not prove port ownership or provide local authentication. The host environment is trusted, including the `ProgramFiles`/`ProgramW6432` allowlist used to locate the Compose plugin. Bootstrap owns only direct children; Docker helpers and process trees are not guaranteed to terminate. Real graceful Windows shutdown and OS-signal behavior remain unverified.
- A real cleanup defect was found: concurrent AMQP channel and connection closes could leave the pinned amqplib channel close promise unsettled. Cleanup now closes the channel before the connection while PostgreSQL close remains independently tracked. After terminal forced cleanup, late-arriving resources are force-destroyed only; no new driver close operation is started.
- The isolated relay integration test requires both `INTEGRATION=1` and `RUNTIME_RELAY_ISOLATED=1`, disposable isolated services, a unique queue and event filter, and unrelated outbox and retry-publication sentinels. These restrictions protect unrelated work; never run against shared services. The test with both sentinels passed against fresh isolated PostgreSQL and RabbitMQ as reported below.

### Frontend component inventory and limitations

`frontend/src/TestEventPanel.tsx` and `test-event-api.ts`, integrated with the automation dashboard/editor and existing API/history components, implement a test-event form for a saved active compatible automation. It discloses scope-wide matching and sends only the flat `receipt.v1` / `local-receipt` contract with an app-generated idempotency key. An uncertain intent can be recovered from session storage with the same payload/key; an in-document ownership registry and compare-before-remove protect against stale completion, not cross-tab coordination. The panel fetches accepted event and execution results, offers manual refresh, presents human-readable status/results and collapses technical details. Existing execution history is capped at 100 and is not newest-first; it is not complete discovery.

Automatic polling, global event/execution discovery and runtime status are not implemented. The form explicitly says service readiness cannot be confirmed; **the required runtime/snapshot submission gate is not implemented**, so this partial UI must not be treated as safe readiness-based enablement. Event Explorer remains an advanced surface; the primary information architecture is incomplete. Related frontend work includes automation/dashboard and execution-history presentation, API/condition contracts, styling, and ViaCEP builder components; ViaCEP outbound execution remains disabled under [ADR 0005](0005-viacep-address-lookup.md). [ADR 0004](0004-automation-list-dashboard.md) remains the predecessor for the automation dashboard.

### Evidence classification and limits

The following are **reported execution results**, not independently rerun for this documentation update. The working-tree source and tests were inspected; the supplied run reports are the evidence for counts and real-service observations. No browser, OS-signal or retry-recovery conclusion is inferred beyond what is stated.

- **Backend automated, latest reported checkpoint:** **907 passed / 61 skipped**, with `INTEGRATION=0`, before/at the IPC event fix. Later supervisor E2E did not include a broad backend rerun. The supplied count is a reported result, not a rerun by this documentation update; real-service tests are listed separately below.
- **IPC targeted evidence:** **32 passed** in the reported targeted fake/subprocess tests. A bounded real subprocess exercised IPC `shutdown` and clean exit; disconnect and mixed OS/IPC behavior remain unit-tested, not proof of real parent death.
- **Frontend automated, implementation checkpoint:** **232 tests passed**; typecheck, lint and build passed. Browser and accessibility testing were not run.
- **Real services, official integration rerun:** **34/34 passed**. This is separate from the isolated relay lifecycle test and is not proof of a complete app launcher.
- **Real services, isolated relay lifecycle:** the test with both unrelated outbox and retry-publication sentinels reported **1/1 passed** against fresh isolated PostgreSQL and RabbitMQ; relay one-shot exited 0, daemon remained alive, and a contender reported busy. No real parent-disconnect or OS-signal verification is claimed.
- **Focused real end-to-end observation:** the isolated controlled test explicitly enabled snapshots; this is test evidence, not launcher authorization. An automation was created and activated via HTTP; the first event was confirmed and completed with a typed local receipt and matching pinned execution. Duplicate relay and scheduler contenders were busy. A second event remained pending while relay was down, then was confirmed and completed automatically after forced relay restart, with a typed result and matching execution. A reported privacy scan was clear; observed logs omitted credentials and actual message markers. Forced Windows termination is not evidence of graceful signal shutdown.
- **Managed-infrastructure real supervisor E2E, reported functional gates passed:** a no-terminal run observed `singleton_owned`, `bootstrap_ready`, five role starts and readiness; a duplicate launch exited 0. The first event was confirmed and completed with a typed receipt and pinned execution. Relay was terminated with explicit Windows exit code 3; restarting and replacement were observed, and a second event was confirmed and completed. After forced cleanup, no app survivors or occupied app ports remained. Forced `taskkill` is not graceful shutdown evidence. The supervisor log scan was clear; child output was discarded. The earlier raw six-child observation is superseded by allowlisted role events; no helper root cause is established. QA removed the test-created managed Compose resources; the supervisor intentionally never runs Compose down or removes volumes.
- **Unverified retry/scheduler restart recovery:** the first attempt failed at the AMQP handshake after diagnostics ping; one diagnostic rerun failed Rabbit diagnostics readiness before app startup. Neither proves a scheduler defect or recovery. Real graceful Windows shutdown also remains unverified.

### Outstanding acceptance and inventory boundaries

Missing or not accepted: complete ordinary-user shortcut/packaging and integrated acceptance; verified parent-death handling for API, worker and frontend; `/runtime/status` and the submission gate; actual graceful Windows shutdown; retry/scheduler recovery evidence; paginated event/execution discovery; Overview/Problems aggregate contracts; automatic polling; browser E2E and accessibility; and production/deployment approval. The implemented launcher and supervisor are a controlled slice, not proof of complete acceptance. No commit, push, deployment or enablement is authorized by this update.

### Architectural component and source inventory

| Component                      | Source / evidence                                                                                                                                                                                                    | Status                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Role lifecycle and entrypoints | `backend/src/runtime-{executable,entrypoint,role,loop,lock}.ts`, `relay-main.ts`, `scheduler-main.ts`, `backend/package.json`; `backend/test/runtime-{executable,entrypoint,role,primitives,lock-heartbeat}.test.ts` | Implemented roles under the composed supervisor; IPC evidence is not parent-death proof.                                    |
| Disposable adapters            | `backend/src/runtime-{resources,relay,scheduler}.ts`, `relay.ts`, `scheduler.ts`; corresponding `runtime-resources`, `runtime-relay` and `runtime-scheduler` tests                                                   | Implemented per-sweep adapters; real isolated relay evidence is separate from unverified scheduler recovery.                |
| Isolated relay proof           | `backend/test/runtime-relay.integration.test.ts`                                                                                                                                                                     | Opt-in isolated-service test with filtered fixture and both sentinels; reported 1/1 passed against fresh isolated services. |
| Test-event UX                  | `frontend/src/TestEventPanel.tsx`, `test-event-api.ts`, `AutomationDashboard.tsx`, `Automations.tsx`, `ExecutionHistory.test.tsx`, and corresponding panel/API tests                                                 | Partial app-driven interaction; point-in-time results and manual refresh, not readiness-gated polling or complete history.  |
| Supervisor and launchers       | `backend/src/runtime-{supervisor-main,supervisor,supervisor-singleton,bootstrap,preflight,children}.ts`, `start-intelifluxo.cmd`, `start-intelifluxo.ps1`; corresponding runtime tests                               | Composed local runtime; reported managed-infrastructure E2E, with spoofing, process and shutdown limitations above.         |
| API, worker and infrastructure | `backend/src/api.ts`, `executions.ts`, `contract.ts`, `worker-main.ts`; PostgreSQL and RabbitMQ                                                                                                                      | Existing components composed by supervisor; dependency preflight is not a runtime-status contract.                          |
| ViaCEP and predecessors        | `frontend/src/ViaCepBuilder.tsx`, `viacep-graph.ts`; [ADR 0004](0004-automation-list-dashboard.md), [ADR 0005](0005-viacep-address-lookup.md)                                                                        | Builder slice only; outbound ViaCEP execution remains disabled.                                                             |

The source files and tests above are implementation evidence; the run counts and real-service observations are supplied reports, not artifacts independently reproduced here. Technical owner review of these reported checkpoints and remaining runtime/security risks is still required.

## Decision and boundaries

**Status: accepted target; partially implemented as classified above.** Requirements in this section and the product, security, observability and acceptance sections below describe the decision or future work, not proof that the complete workflow exists.

Use one local supervisor/launcher to own five separate persistent processes:

```text
App shortcut / launcher (developer command uses the same supervisor)
  ├─ frontend server → browser app
  ├─ API → PostgreSQL (event + outbox + saved-revision snapshots)
  ├─ relay-loop → PostgreSQL outbox → RabbitMQ
  ├─ worker ← RabbitMQ → PostgreSQL (results / retry dispositions)
  └─ scheduler-loop → PostgreSQL (eligible retry publications)
                          ↑ relay-loop publishes these too
```

The API does not host relay/scheduler loops or a broker. PostgreSQL/RabbitMQ retain their established responsibilities. Infrastructure may be pre-provisioned for this slice; the launcher must detect its absence and offer actionable non-terminal diagnostics, not silently claim readiness. Infrastructure installation and lifecycle ownership must be documented before the no-terminal acceptance demonstration.

### Required backend runtime

- Reuse `relayOnce` and `scheduleOnce`; do not duplicate their business transitions in the supervisor. Each role has at most one in-flight sweep, scheduling the next only after completion/settlement. Enforce bounded batch sizes, bounded waits and operation deadlines. Never implement timeout by abandoning a promise and starting overlapping work.
- Idle and failure waits use bounded backoff with jitter. Reset after successful recovery according to reviewed configuration. Retry-loop timing is distinct from persisted business retry eligibility and must not rewrite it.
- Bound database acquisition/query, broker connection/confirmation and shutdown waits. On deadline, stop the affected operation and close/cancel its resources before another sweep; uncertain publication remains eligible for retry.
- Stop admitting new sweeps on shutdown, drain in-flight work within a grace period, then close owned connections. Worker shutdown must preserve acknowledgment-after-commit and redelivery safety. Supervisor escalation must target only its owned processes.
- Restart failed children with backoff/jitter and a finite restart budget within a configured window. Budget exhaustion is visible degradation requiring explicit local recovery, not an infinite crash loop. A hung child also consumes the recovery budget when terminated/restarted.
- Choose, document and test concrete interval, timeout, freshness, grace-period and restart-budget values before enablement. No values here are benchmark claims.

### Cooperative singleton and process identity

The launcher has a stable local instance identity and strict configured ports. A second launch may focus/reuse a verified existing instance or fail clearly; it must not select alternate ports, attach to an unrelated process, kill a port owner or create another runtime silently. Stale launcher identity requires verification before cleanup. Process IDs alone are insufficient identity.

Each relay and scheduler role uses a distinct, documented PostgreSQL **session advisory lock**, shared by its daemon and every supported one-shot command. Lock keys identify the same logical runtime/database role across launch paths, not a random process instance. Hold the role lock for the daemon lifetime or entire one-shot operation on a dedicated connection; never return a lock-holding connection to a pool. Contention must perform no sweep and report a safe busy state. Release on orderly exit; session termination releases ownership.

On lock-session loss, stop new work immediately and close/cancel the role's owned resources. Restart only after reacquiring ownership. All cooperating entry points must adopt this discipline before loops are enabled. A legacy command bypassing it is unsupported concurrent operation.

These locks are cooperative database ownership, **not RabbitMQ fencing**. A lost database session can release a lock while an old broker publication is still in flight. At-least-once delivery and duplicate-safe consumers remain necessary; no exactly-once or distributed fencing guarantee is added.

### Immediate UX using existing event contracts

“Send test event” means **send an event to the scope**, not execute the selected automation directly. All matching active automations can snapshot their saved revisions at acceptance. Explain this before submission. There is no automation-target override, draft execution or matching bypass.

Enable the action only for a saved active revision, a supported event scope, enabled snapshots and a healthy supported runtime. Disable it with a reason for inactive, unsaved/dirty, snapshots-off, unsupported-scope or degraded/unknown runtime states. The selected revision is context, not a guarantee against concurrent revision changes: the server's acceptance-time snapshots are authoritative. Never auto-save, activate a definition or enable a gate as a side effect of testing.

1. Construct an existing-contract synthetic `receipt.v1` / `local-receipt` event with scope and message only. The current flat event contract has no arbitrary data field. Generate the idempotency key in the app, once per explicit send intent.
2. Use `POST /events`; retain the same key and exact payload for an ambiguous transport retry. An explicit new send gets a new key. Do not silently generate a fresh key after a timeout or 409. Preserve pending identity through the supported retry lifecycle, including reload if retry is offered after reload.
3. Use the returned ID with `GET /events/:id` and `GET /executions?eventId=...`. Existing automation history may use `GET /executions?automationId=...`; do not send both filters or new pagination parameters to that route.
4. Poll with bounded request count/duration, timeouts and backoff; cancel on navigation or superseding intent. Stop at authoritative terminal results or the polling budget. On budget exhaustion, show the last observed state and offer refresh; do not label the event failed merely because observation stopped.

Acceptance is not execution completion. Show only persisted event/publication/retry/execution states; local request indicators must be explicitly labeled as UI activity. Do not fabricate “processing,” equate an empty execution response with success, or infer complete history from a capped list. Expose UUIDs and raw JSON through progressive disclosure rather than making them the primary workflow. No WebSocket is needed.

Frontend work can implement this existing-contract interaction immediately, but must not claim no-terminal completion or enable testing based on the current static `/status`. Runtime readiness depends on the backend/launcher work above.

### Required later history contracts before v0.1 completion

Add **`GET /events/list` and `GET /executions/list`** with bounded, newest-first keyset pagination before declaring v0.1 complete. These are additive future routes, not presently available contracts and not prerequisites for coding the immediate send-and-observe interaction.

Contract review must specify allowlisted filters, page-size default/maximum, response projection, cursor validation and errors. Use a stable unique tie-breaker with creation time, such as descending `(createdAt, id)`; cursor scope/filter binding must prevent silently switching result sets. Define behavior under concurrent inserts explicitly: keyset traversal is not a transactionally frozen snapshot unless a separate contract promises it. Test timestamp ties and page boundaries. Keep strict existing routes unchanged, including unknown-parameter rejection; test static `/events/list` dispatch against `/events/:id`.

The scope validation mismatch requires reviewed alignment across API schemas, storage constraints, frontend validation and contract tests. Until approved and implemented, reject/disable unsupported event scopes visibly. Never trim, truncate, lowercase, slugify or silently map one scope to another. Scope is not authorization.

### Read-only runtime status contract

Add a read-only runtime-status endpoint, with its route and versioned schema reviewed by backend/frontend/QA. Keep the existing limitations disclosure; do not quietly reinterpret static `/status` as a health proof. The endpoint reports safe component states such as `starting`, `ready`, `degraded`, `stopped` and `unknown`, observation freshness and allowlisted reason codes. Readiness covers required child processes, dependency connectivity, role ownership and effective feature capabilities, not merely API reachability.

Freshness expiry, missing evidence and API unreachability must not appear green; the frontend treats them as unknown/degraded. A successful status read cannot guarantee the next write succeeds. Do not expose secrets, connection strings, raw exception stacks, arbitrary paths, command lines or event payloads. This endpoint cannot run sweeps, restart processes or toggle gates. **No HTTP relay/scheduler control routes.** Supervisor lifecycle actions stay local to the launcher.

## Product Experience Overhaul: domain and state contract

The supplied Product Experience Overhaul is authoritative product direction. The following separates existing domain evidence from required backend additions; it does not make unavailable states or APIs real by renaming them in the UI.

| Domain concept               | Meaning and boundary                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition / revision        | Stable automation identity and immutable saved revision containing the graph/configuration and active flag. The current revision controls future matching; an execution remains pinned to its acceptance-time revision.                                                       |
| Event submission             | App intent followed by durable event acceptance, scoped idempotency identity and outbox publication. A submission can match multiple automations or none; it is not itself one automation execution. A local unsent form is not a durable event.                              |
| Execution                    | Snapshot of one matching automation revision for one accepted event. Its identity is not regenerated for each retry. It is distinct from publication and from the event-wide retry lifecycle.                                                                                 |
| Attempt / evidence           | A processing attempt is distinct from an execution and publication generation. The current retry attempt counter and latest disposition are not an append-only attempt history. Broker confirmation proves publication, not worker start or business completion.              |
| Result                       | Persisted, versioned execution evidence: action outcome and, where supported, condition/lookup observations and failures. A local receipt is not proof of an external delivery. Missing result is not failure or success.                                                     |
| Retry / recovery disposition | Persisted event-level eligibility, generation, attempt, outcome and reason. It may affect multiple executions; an ignored execution can coexist with retries/problems elsewhere on the same event. Recovery authorization is a separate command boundary, not a status label. |

### Draft, Active and Disabled

The inspected definition model has a saved revision with an `active` boolean, not a persisted three-state Draft/Active/Disabled lifecycle. **Active** means the saved current revision has `active=true`; **Disabled** means `active=false`. An unsaved new graph or dirty edits may be labeled **Draft (unsaved locally)**, but must not be represented as a durable server draft. A saved inactive automation is Disabled even if it has never executed. Do not infer Draft from absence of executions or invent published/draft revision pointers, archived/deleted states or activation timestamps.

Dirty edits over an active saved automation do not disable that saved revision: incoming events can still match it. Show saved activation separately from unsaved editing state and disable the editor's test action until saved. Changing activation affects future acceptance, not already pinned executions. Persisted drafts or a publish lifecycle require a separately reviewed model/contract change, not a frontend-only enum.

### Evidence-backed lifecycle presentation

These are presentation mappings over existing evidence, not replacement wire enums. Keep publication, execution result and event retry disposition visible as separate dimensions. Terminal execution evidence takes precedence for that execution; never overwrite an ignored result with a parent's pending retry label.

| User-facing state               | Required evidence / restriction                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queued / awaiting publication   | Accepted durable event with publication pending, before a terminal result. “Queued” means local outbox pending, not proof that RabbitMQ has received it.                                                                                                                 |
| Sent / awaiting result          | Broker-confirmed publication without a persisted terminal result. “Sent” means sent to the broker, not to an external recipient; no worker-start inference.                                                                                                              |
| Retry scheduled                 | Persisted `retry_scheduled` disposition with eligibility time; show the server time rather than promising execution at that instant.                                                                                                                                     |
| Retry released                  | Persisted released generation/current API `retry_released`; distinguish its pending versus confirmed publication where available. Release is not worker start.                                                                                                           |
| Completed                       | Persisted completed outcome/result. Explain the actual local action, not a generic claim that every automation or external system succeeded.                                                                                                                             |
| Ignored                         | Persisted execution action `ignored`; explain the recorded condition/outcome where available. This is not failure.                                                                                                                                                       |
| Failed                          | Human-readable result classification only when recorded failure evidence supports it. Show transient versus terminal explicitly; do not invent a generic `failed` wire status or derive it from a network error.                                                         |
| Blocked / awaiting intervention | Persisted `blocked` with its reason (permanent, unknown or exhausted). “Awaiting intervention” explains lack of automatic progress, not an existing assignment, approval workflow or recovery capability. Unknown outcome must not be stated as proven business failure. |

An accepted execution lacking publication details may remain “Accepted; publication not observed” until its event is read. Inconsistent or unavailable evidence is unknown/stale, not a new business state. **Processing/running is forbidden without durable start/ownership evidence**; elapsed time, spinner activity, consumer liveness and broker confirmation do not supply it. No fabricated attempt start/end timestamps or inferred step durations.

### API gaps and direct implementation contracts

| Product surface                    | Existing evidence and required contract work                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                           | Runtime status plus existing entity reads can show explicitly partial observations only. Accurate scope/time-window totals, outcome counts and oldest pending work need backend aggregate projections with as-of time, filter definitions and event-versus-execution counting rules. Do not compute global totals from the first 100 rows or count ignored results as failures.                                                                                                        |
| Paginated/filterable Executions    | Deliver the additive `/executions/list` contract above, with reviewed scope, automation, event, outcome/disposition and time filters as supported by storage. Define indexes, cursor binding and independent event/execution status semantics. No undocumented filters on the strict legacy endpoint.                                                                                                                                                                                  |
| Execution detail / attempt history | Existing `GET /executions/:id` supplies pinned identity, latest result and event retry projection, not a full attempt timeline. Detail may join existing event evidence now. Complete history requires durable append-only attempt/evidence records and an additive bounded read contract; specify identity, event-wide versus execution-specific attribution, deduplication and retention. Never manufacture historic attempts from an integer counter or backfill invented evidence. |
| Problems                           | Project persisted blocked/failure reasons and separately runtime degradation, with scope, source, as-of time and pagination. Define how one event-wide problem links to multiple executions without misleading duplicate totals. “Problem resolved,” assignment and acknowledgment are unavailable unless backed by new durable contracts.                                                                                                                                             |
| Human-readable results             | Map validated versioned result codes to safe explanations: action performed, condition ignored, retry pending or recorded failure reason. Keep source/version and technical details available on demand. Unsupported versions display an explicit unsupported/unavailable explanation, not optimistic success; no raw JSON-only primary experience or invented provider result.                                                                                                        |
| Authorized recovery                | No recovery command is approved or implemented by this ADR. A future contract must define actor authorization, eligible dispositions, event-wide impact, immutable revision behavior, expected-state/concurrency checks, idempotency, audit evidence and duplicate external-effect risk. Until reviewed and implemented, Problems is diagnostic and cannot offer a working retry/replay/repair button. No HTTP sweep control as a substitute.                                          |
| Settings / Integrations            | Show only actual safe configuration/capabilities and established dependencies. Redact credentials, URLs containing credentials, tokens and environment values; never offer secret reveal. Do not invent connector catalogs, connection success or installed integrations. ViaCEP remains explicitly disabled for external execution; no settings toggle may bypass approval.                                                                                                           |

Aggregate, history and recovery route names and wire schemas beyond the approved list routes are deliberately not invented here. Backend/frontend must settle each required contract directly with QA using real storage evidence; product-visible missing capability remains explicit. A no-auth local profile cannot pretend to provide authorized recovery merely by adding a confirmation dialog. Any recovery enablement needs an approved authorization/security boundary.

### Phase 1 → Phase 2 handoff and integrated proof

Phase 1 is the immediate existing-contract interaction and domain mapping; Phase 2 is the required supervised runtime and reviewed additive product contracts. Transfer directly from Phase 1 to implementation with one shared contract checklist: exact existing request/response fixtures, state-to-evidence mappings above, unsupported states, agreed status/list/aggregate/history schemas as they become necessary, ownership, and executable acceptance cases. Backend owns persistence/contract correctness, frontend owns faithful consumption, QA owns cross-boundary verification, and Lead resolves scope/security decisions. Do not introduce another broad documentation phase or block usable existing-contract implementation on speculative recovery or persisted-draft design.

Deliver **one integrated local demonstration**, not disconnected UI mocks and backend scripts: launch via shortcut; observe readiness; inspect a saved active automation; send a scope-wide synthetic event; see persisted event and execution evidence with readable results; inspect a controlled retry/blocked case and truthful Problems diagnostics; interrupt/recover a dependency and observe degraded/readiness transitions without manual sweeps. Show disabled/unsaved restrictions, default-off capabilities and disabled ViaCEP external execution. Demonstrate paginated history when its required v0.1 contract lands, and label absent attempt-history/recovery capabilities honestly rather than simulating them. Controlled fixtures/fault setup must be disclosed and separately approved; the ordinary-user path remains terminal-free. Record a single end-to-end evidence trail with event/execution IDs and sanitized observations. Missing required backend contracts block the affected product capability/completion claim, not all Phase 1 work.

## Alternatives

| Alternative                                    | Decision and trade-off                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Manual terminal commands and one-shot sweeps   | Retain for controlled developer diagnostics under shared locks; reject as ordinary-user acceptance. |
| Embed loops in API                             | Reject: couples request availability, ownership and recovery; increases duplicate-loop risk.        |
| Separate processes under one launcher          | Select: explicit lifecycles and failure isolation, at the cost of supervision and readiness work.   |
| HTTP “run relay/scheduler now” buttons         | Reject: turns a read surface into privileged orchestration and masks missing runtime ownership.     |
| Target one automation or execute unsaved graph | Reject: bypasses scope matching and immutable saved-revision semantics.                             |
| WebSocket status stream                        | Defer: bounded polling meets immediate needs without another state/delivery contract.               |
| Replace PostgreSQL/RabbitMQ or build a broker  | Reject: unnecessary infrastructure scope and risk.                                                  |

## Failure semantics and recovery

| Failure / boundary                                          | Required behavior                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Acceptance response lost                                    | Retry exact intent/key; replay returns the existing event without rematching; changed content conflicts.                  |
| Broker confirms, relay crashes before database confirmation | Publication may repeat; retain at-least-once semantics and existing deduplication.                                        |
| Database or broker unavailable                              | Bound waits, back off, mark runtime degraded and disable test action; do not discard pending durable work.                |
| Advisory-lock connection lost                               | Stop new sweeps, tear down role resources and reacquire before recovery; in-flight Rabbit work may still duplicate.       |
| Scheduler crashes before/after commit                       | Roll back incomplete work or rediscover committed generation; preserve transactional eligibility checks.                  |
| Worker dies before acknowledgment                           | Redelivery is expected; committed outcomes must remain duplicate-safe.                                                    |
| Polling fails or expires                                    | Observation is stale/unknown; preserve accepted event identity and offer bounded refresh.                                 |
| Child repeatedly crashes or port conflicts                  | Stop automatic restart at the configured budget; expose safe diagnostics, never steal ports.                              |
| Business retries exhaust                                    | Preserve existing blocked/retry outcomes and diagnostic visibility; no new replay, repair or business DLQ API is implied. |

Loop retry is infrastructure recovery, not permission to retry terminal business work indefinitely. Durable database state remains the recovery source; launcher shutdown does not delete events or reset retry generations. PostgreSQL session locks do not provide remote side-effect exactly-once behavior.

## Security and limitations

- Bind API and frontend to loopback only. Validate expected Host values to resist rebinding, and enforce explicit trusted Origin checks on browser writes; do not rely on CORS alone. Review missing/null Origin handling for local developer clients explicitly and test it, rather than accepting all absent origins by accident.
- Display the local-only, synthetic-data, **no authentication / no tenant isolation** limitation. Scope filters and loopback binding are not authentication; hostile local processes remain outside this profile's protection.
- Keep gates default-off. The launcher must not silently enable snapshots, condition writes or ViaCEP writes/execution. The isolated test's explicit snapshot enablement does not authorize launcher enablement. Any future ordinary-user local profile requires explicit approved configuration and capability disclosure; testing becomes available only under separately approved configuration.
- **ViaCEP external execution remains disabled.** This ADR does not authorize outbound provider traffic, customer data, secrets in sample events or broader network exposure. ADR 0005 is not enablement approval here.
- Treat the host environment and Compose plugin allowlist as trusted; loopback probes and singleton identity are vulnerable to local spoofing. Direct-child control does not guarantee descendant cleanup.
- Redact logs and status. Use least-privilege database/broker access and owned-process shutdown. Do not silently install services, change firewall rules or perform destructive database initialization.
- MCP tool connectivity and RAG retrieval are separate capabilities; neither is needed for this runtime decision.

The design increases local process-management complexity and does not solve multi-host leadership, fencing, capacity admission, authentication, broker replacement, production deployment or external exactly-once effects. Existing capped reads remain incomplete until additive pagination ships.

## Observability

Record structured component lifecycle, instance identity, lock acquisition/contention/loss, sweep duration/count/outcome, dependency reconnects, deadline expiration, restart count/budget exhaustion and shutdown escalation. Correlate persisted event/execution IDs where needed without logging raw payloads or idempotency secrets. Surface last successful sweep and freshness separately from process liveness; zero rows in a healthy sweep is not a fault.

Expose pending-publication/retry backlog age and safe counts where available; do not equate “process running” with “work progressing.” Document how an ordinary user retrieves sanitized diagnostics through the launcher without a terminal. Logs/status must distinguish disabled capability, unavailable dependency and terminal business outcome.

## Staged ownership, rollout and rollback

| Stage                                   | Responsible collaboration / exit condition                                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: immediate existing-contract UX       | Frontend implements scope disclosure, guards, idempotent send and bounded polling; backend confirms current contracts; QA tests with controlled fixtures. No runtime-complete claim.                                                                                   |
| 2: runtime and safe status              | Backend/runtime owner implements supervisor, launcher/shortcut, loop wrappers, shared one-shot locks, deadlines, budgets, safe status and Host/Origin checks. Frontend consumes reviewed status. QA performs no-terminal and fault tests before controlled enablement. |
| 3: complete history and scope alignment | Backend proposes additive list schemas and explicit scope reconciliation; frontend integrates after contract review; QA verifies compatibility/pagination. Required before v0.1 completion.                                                                            |
| 4: release evidence                     | Documentation records launcher prerequisites, safe recovery and rollback; independent reviewer verifies critical runtime/security changes. Lead accepts integration evidence and human approval controls any enablement/deployment.                                    |

These are ownership boundaries, not delegated work or overlapping file assignments. Concrete assignees and configuration/schema choices remain with Lead. This ADR changes documentation only.

Roll out with all gates off and no enablement without approval: validate the implemented launcher and readiness under the supported environment, exercise the implemented lock-aware one-shot and daemon scripts in controlled synthetic tests, then gate the existing-contract UX on reviewed readiness, then add history. Current scripts share role locks: a one-shot contender while its daemon owns the lock reports busy and must not sweep; unsupported bypasses remain unsafe. Establish infrastructure preflight, reviewed finite timing/budget values and independent security/recovery review before enabling test sends.

Rollback requires disabling or removing the partial UI action and stopping the supervisor and its owned children under an approved local procedure, preserving durable rows and gate defaults. The supervisor does not remove managed Compose resources or volumes; any separate infrastructure cleanup requires human approval. Direct-child controls do not guarantee descendant cleanup. Use the first-signal drain policy where supported and escalate under an approved procedure; actual graceful Windows shutdown and OS-signal behavior remain unverified. Revert to controlled lock-aware one-shot diagnostics only after proving daemons stopped; this is not no-terminal acceptance. Do not delete outbox/retry rows, reset generations or downgrade an additive contract while clients still depend on it. Document migration compatibility before any future schema rollback; this decision itself requires no destructive migration.

## Test acceptance and evidence required

Implementation acceptance requires recorded automated results plus a no-terminal demonstration. The partial evidence above does not satisfy that acceptance.

1. From the supported prepared local environment, an ordinary user opens the shortcut, sees truthful readiness and sends/observes a synthetic event without shell commands or manual sweeps. Missing infrastructure produces actionable diagnostics, not false readiness.
2. Duplicate launch, stale identity and occupied-port cases never create a second unverified runtime, change ports or kill unrelated processes. Daemon/one-shot contention runs zero losing sweeps; lock-session loss stops admission. Demonstrate possible duplicate delivery remains harmless, not fenced.
3. Instrumented slow/hung sweeps show maximum per-role concurrency of one, bounded batches/deadlines and no abandoned-operation overlap. Crash/reconnect/shutdown tests remain inside configured grace/restart budgets; budget exhaustion becomes degraded.
4. Fault injection at acceptance response, broker confirm/database update and worker commit/ack boundaries preserves durable work, replay identity and duplicate-safe results. Scheduler retry generations remain consistent across restart. Dependencies recover without manual sweeps.
5. A same-scope event snapshots all matching active saved automations, no inactive/draft override; replay does not rematch. UI tests cover every disabled reason, concurrent revision changes, 409, ambiguous response retry, poll exhaustion and stale status. No fabricated processing/completion state appears.
6. Strict legacy routes still reject extra parameters and incompatible filters. Scope mismatch is visible with no normalization. New list tests cover ties, inserts between pages, bounded page size, malformed/filter-mismatched cursors, static-route dispatch and newest-first order before v0.1 completion.
7. Security tests reject untrusted Host/Origin writes, cover reviewed missing/null-Origin policy, verify loopback binding and redaction, and prove no HTTP runtime-control routes exist. Freshness expiry disables testing. Defaults remain off and ViaCEP sends zero external requests.
8. Sanitized diagnostics contain sweep/restart/lock evidence and distinguish liveness from progress. Independent review records unresolved risks; demonstration records environment and configured budgets rather than presenting invented SLOs.

The reported checkpoints above are partial; remaining backend/frontend runtime, fault, security and no-terminal acceptance tests still require evidence. Documentation validation is reported separately with this update. **No deployment or enablement approval is granted**.
