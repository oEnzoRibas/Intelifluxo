# ADR 0002: Persistent visual workflow graph over automation revisions

- Status: Accepted for the Visual Workflow Builder increment
- Date: 2026-11-08
- Scope: Incremental Visual Workflow Builder persistence, not a new execution engine

## Evidence and constraints

- [Migration 004](../../backend/migrations/004_automation_definitions.sql) stores immutable revisions as **relational columns**, including `schema_version = 1`, fixed trigger/action types and `active`. There is no definition JSON column. Revisions cannot be updated/deleted; the current pointer advances by exactly one.
- [Migration 005](../../backend/migrations/005_automation_executions.sql) stores execution snapshots and a JSONB **result**, not a definition graph. Executions reference an immutable definition revision.
- [Definition routes](../../backend/src/automations.ts) and [generated schema](../../backend/schemas/automation-v1.schema.json) accept only the fixed receipt pair, reject additional properties, create inactive revision 1, and use a row lock plus `expectedRevision` for PUT. GET returns current revisions only; list is scope-filtered and limited to 100.
- [Acceptance](../../backend/src/accept.ts) matches active relational revisions in one statement when the snapshot gate is enabled. [Worker](../../backend/src/worker.ts) understands only schema version 1, `receipt.v1` and `record-receipt.v1`; it does not traverse a graph. A condition disguised as that pair would otherwise execute unconditionally.
- [Frontend API](../../frontend/src/automation-api.ts) strictly checks response keys, and its update helper toggles activation with fixed fields. [UI](../../frontend/src/Automations.tsx) has create/list/detail/toggle, stale-read protection, and ambiguous-write warnings, but no persistent editor.
- [ADR 0001](0001-visual-automation-mvp1.md) remains authoritative for snapshotting, retries, internal receipt effects, and deployment restrictions. No executable Condition, HTTP action or ViaCEP exists in this evidence.

These are source observations, not executed test results. There are no supplied throughput targets or production authorization requirements; this proposal retains the local-only security boundary.

## Decision

Extend each immutable automation revision with an optional `graph` document. Keep the current endpoints, scope, revision protocol, fixed trigger/action projection, schema version 1, and execution contract. `graph.version` versions the graph independently of execution `schemaVersion`. This version is a bounded linear graph, not a general DAG engine.

The normal catalog contains only Receipt trigger and Record receipt action. An optional, explicitly labelled **Condition placeholder — not executable** may be offered for draft planning. Its presence always blocks activation. Do not expose ViaCEP, generic HTTP, arbitrary unknown nodes, expression editing, branching, credentials or executable condition controls. A UI may omit the placeholder catalog entry entirely in the first release; backend behavior must still fail closed.

### Explicit graph contract (version 1)

Every object below rejects unknown properties. JSON field order has no meaning.

```json
{
  "version": 1,
  "nodes": [
    { "id": "trigger", "kind": "trigger", "type": "receipt.v1", "position": { "x": 0, "y": 0 } },
    { "id": "action", "kind": "action", "type": "record-receipt.v1", "position": { "x": 320, "y": 0 } }
  ],
  "edges": [
    { "source": "trigger", "target": "action" }
  ]
}
```

- Required graph keys: `version`, `nodes`, `edges`. Exactly 2 or 3 nodes and respectively 1 or 2 edges.
- Required node keys: `id`, `kind`, `type`, `position`. ID matches `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, is unique within the graph and is retained across saves, moves, renames of the automation, activation and reopen. New nodes get an ID once; no array-index identities or regeneration on render. IDs are local to an automation, not execution IDs.
- Allowed `(kind, type)` pairs: `(trigger, receipt.v1)`, `(action, record-receipt.v1)`, and optionally `(condition, condition-placeholder.v1)`. Exactly one trigger, exactly one action, at most one condition. No config, predicate or output mapping is accepted in v1.
- Position has exactly finite JSON numbers `x`, `y`, each between -10000 and 10000 inclusive. These proposed bounds are input safeguards, not measured product requirements. Position is persisted presentation state, never execution order. Zoom, selection and viewport are not persisted.
- Edge has exactly `source`, `target`, both node IDs. Its identity is the ordered pair; a separate edge UUID adds no value without parallel edges or edge metadata. No duplicate pairs, self edges, dangling references, ports or branch labels.
- Only complete paths `trigger -> action` and `trigger -> condition-placeholder -> action` are valid. Inactive is not permission to persist malformed or disconnected graphs. Temporary incomplete edits stay in local editor state until valid.
- Node/edge array order does not define execution. Preserve submitted arrays on round-trip; clients must compare structure without depending on JSON object key order.

To add the optional placeholder to the example, insert:

```json
{ "id": "condition", "kind": "condition", "type": "condition-placeholder.v1", "position": { "x": 160, "y": 0 } }
```

and replace edges with `[{"source":"trigger","target":"condition"},{"source":"condition","target":"action"}]`. This is persistable only while inactive; it never means an always-true condition.

### API contract

No new route or implicit auto-save. New clients always send a complete graph. Legacy requests may omit it under the compatibility rules below.

`POST /automations` request (201 response):

```json
{
  "scope": "demo",
  "name": "Receipt workflow",
  "schemaVersion": 1,
  "trigger": { "type": "receipt.v1" },
  "action": { "type": "record-receipt.v1" },
  "graph": {
    "version": 1,
    "nodes": [
      { "id": "trigger", "kind": "trigger", "type": "receipt.v1", "position": { "x": 0, "y": 0 } },
      { "id": "action", "kind": "action", "type": "record-receipt.v1", "position": { "x": 320, "y": 0 } }
    ],
    "edges": [{ "source": "trigger", "target": "action" }]
  }
}
```

Creation still forbids a client `active` field and returns `active:false`, `revision:1`. The response has existing keys `id`, `scope`, `revision`, `name`, `active`, `schemaVersion`, `trigger`, `action`, `createdAt`, plus required `graph` from the upgraded server. Existing string validation and UUID rules remain unchanged.

`PUT /automations/:id` accepts exactly `expectedRevision`, `active`, `name`, `schemaVersion`, `trigger`, `action`, `graph` (graph optional only for legacy compatibility). It is full replacement of mutable content, not PATCH; scope is immutable. For example, saving the above graph after creation sends `expectedRevision:1`, `active:false`, and the same name/schema/trigger/action/graph, without scope. Success returns the complete definition at revision 2 (200). Activation sends the complete saved content with `active:true` and the current revision; deactivation sends `active:false`. Even an identical accepted PUT appends a revision, consistent with the existing API.

`GET /automations/:id` and items in `GET /automations?scope=...` return the same full definition shape including graph. Ordering, 100-item cap, no pagination, and no revision-history route remain unchanged. Do not change execution responses or imply per-node execution history.

The relational trigger/action fields must exactly equal the graph's trigger/action node types; reject disagreement rather than silently rewriting either representation. They are a validated execution projection, not an independent workflow definition. `graph.version:1` does not change the worker's `schemaVersion:1`.

### Deterministic validation and errors

Backend validation is authoritative; frontend checks are advisory. Validate request structure before transaction, then lock/read current definition, check existence and expected revision, resolve omitted legacy graph, and validate the effective graph and activation before insert/pointer advance. Failure writes no revision. For legacy graph omission, semantic validation necessarily occurs after loading current content.

For well-shaped requests, validate in this order and report the first failing stage. Within a stage return issues sorted by `(path, code, nodeId, source, target)` lexicographically, with absent optional values treated as empty strings. Graph traversal visits IDs and adjacency lists lexicographically, using a topological cycle check; array order cannot change the verdict.

| Stage | Error codes | Meaning |
| --- | --- | --- |
| Shape/version | `invalid_shape`, `unsupported_graph_version`, `unsupported_node_type` | Required/exact keys, bounds, enum values, version and node pair allowlist |
| Identity/references | `duplicate_node_id`, `dangling_edge`, `duplicate_edge`, `self_edge` | Unique identities and valid directed references |
| Cardinality | `invalid_node_count` | Exactly one trigger/action and at most one placeholder |
| Cycle | `cycle_detected` | Directed cycle found; never try to execute or silently remove it |
| Topology | `invalid_topology` | Trigger indegree 0/outdegree 1; action indegree 1/outdegree 0; condition degree 1/1; every node reachable from trigger and reaches action |
| Projection | `projection_mismatch` | Top-level trigger/action differs from graph |
| Activation | `non_executable_graph` | `active:true` with any placeholder or unsupported execution capability |

Automation request/graph validation uses HTTP 400 with a documented envelope, for example:

```json
{
  "error": "validation_failed",
  "issues": [
    { "code": "non_executable_graph", "path": "/graph/nodes/1", "nodeId": "condition" }
  ]
}
```

Each issue requires `code` and JSON Pointer `path`; `nodeId`, `source`, `target` are optional identifiers, not arbitrary request values. Envelope and issue objects have exact keys. Messages may be shown from frontend-owned code mappings, not parsed server prose. Implement a route-scoped mapping for existing request-schema failures (`invalid_shape`); do not accidentally change event API errors. Unsupported graph version takes precedence over inspecting that version's contents; unsupported type takes precedence over topology validation. Malformed JSON can retain the framework's generic 400; the client must handle non-contract transport errors safely.

Keep existing `404 {"error":"not_found"}` and `409 {"error":"revision_conflict"}`. Keep the existing 8192-byte request-body limit (413). Unknown route/API versions fail, rather than downgrade. The expected-revision bounds remain 1..2147483646. A stale well-shaped update returns conflict before effective-graph semantic validation; refresh and deliberate reapply are required, not automatic retry with a newer revision.

### Save, reopen, edit and activation

1. Open via GET; hydrate the saved graph with its IDs, edges and positions. Keep a saved snapshot/revision separate from the local dirty graph.
2. Save sends the local graph and loaded `expectedRevision`. The default editor save is inactive. If the current definition is active, explicitly warn that saving inactive stops future matching; there is no separate draft head alongside a published head in this slice. No silent deactivation.
3. Activation is a separate explicit confirmation using the saved content and latest revision; require no unsaved changes in the UI. Server still validates any `active:true` PUT regardless of UI behavior. Editing and activating in one API PUT is legal only for an executable graph.
4. After success use the returned revision/content, not an optimistic guessed revision. Reopen from server, not browser storage. Preserve unsaved local edits on validation/conflict; show reload/discard or deliberate reapply options. Never overwrite them with a delayed GET.
5. A network failure may follow a committed write. Reconcile with GET before retrying PUT; aborting a request is not rollback. POST remains non-idempotent: warn to inspect the list before retrying creation. No new idempotency guarantee is implied.

Only the two-node receipt path is executable in this slice. Activation does not enable the snapshot feature gate, execute immediately, replay events or backfill. Deactivation affects future snapshots only. Existing pinned executions, event-level retries, acknowledgement and receipt effects remain exactly as in ADR 0001.

## Persistence and compatibility

**A new additive migration is required.** Add nullable `graph jsonb` to `automation_definition_revisions`; do not modify migrations 004/005 or rewrite immutable revisions. No new graph table, execution migration or general graph interpreter is needed.

- NULL means the legacy two-node receipt graph, not an empty/unknown graph. GET materializes the exact default graph above with fixed IDs `trigger` and `action`; deterministic materialization makes repeated reads stable without writes. The next upgraded-server PUT persists the effective graph in the newly appended revision.
- Add a database CHECK (or equivalent insert guard) that non-NULL graph has supported v1 shape and **any active graph is exactly the executable two-node receipt path with matching relational projection**. It must reject missing/JSON-null fields explicitly, not allow SQL NULL to pass a CHECK. The API owns detailed errors; the database guard is defense against activation bypass and old writers, not a second engine. Test raw inserts as well as HTTP. Legacy SQL NULL graphs remain allowed and executable as before.
- Upgraded POST with omitted graph materializes the default; upgraded PUT with omitted graph preserves the current effective graph under the lock. It must never reset positions/IDs or discard a condition placeholder. `graph:null` is invalid on the API. A legacy toggle trying to activate a stored condition receives 400.
- Current strict frontend readers will reject the new response field. Roll out a transitional frontend parser first: accept exact old shape or exact new shape, materialize defaults only for the old shape, and keep builder editing unavailable against the old API. Then migrate and deploy the upgraded API; enable builder only once server capability/deployment is confirmed. Do not infer persistence from an in-memory default. New builder save must not retry without graph if an old server rejects it.
- Fence old API **writers** before graph editing is enabled. They can append revisions without graph, losing editor state; the additive column alone cannot prevent that. Do not run mixed old/new writers for builder traffic. An upgraded legacy-form request is safe because it preserves graph; an old binary is not. Roll back UI to a graph-aware read-only state if necessary; retain graph-aware backend and migration. Backend downgrade requires disabling definition writes or an independently reviewed preservation adapter.
- Existing compatible receipt workers can remain: active graph semantics are identical, schema version stays 1, and execution snapshots retain the immutable revision reference. This does not relax ADR 0001's prohibition on older, non-snapshot-capable workers. If the placeholder cannot be prevented from becoming active at every write boundary, do not ship its persistence/catalog support.
- Unknown future versions/types are rejected, not silently projected to receipt. A future client must display such a record as unsupported/read-only rather than discard unknown content. Future executable conditions/ViaCEP require a separate execution contract, handler/retry/idempotency design, activation checks, and rollout approval; removing the placeholder restriction alone is unsafe.

## Tradeoffs and risks

| Option/risk | Decision and consequence |
| --- | --- |
| Browser-only graph | Rejected: cannot satisfy persistent reopen or concurrency; positions and IDs would diverge across clients. |
| Separate mutable canvas table | Rejected: graph and immutable execution revision could disagree; introduces another concurrency token. |
| Revision-local JSONB | Recommended: one atomic revision, natural round-trip and audit; migration and strict validation required, revisions grow on layout-only saves. |
| Replace definition schema with a general graph engine | Rejected for this slice: breaks current worker compatibility and expands scope to orchestration semantics. |
| Optional graph on existing API vs new `/v2` endpoints | Additive extension minimizes duplicate routes and projections, but strict response clients need staged upgrade and old writers must be fenced. New major endpoint remains an alternative if independent client deployment is required. |
| Condition planning vs executable promise | Permit only explicitly non-executable placeholder drafts; restricted default catalog reduces confusion. Guard activation in server and DB; never treat placeholder as no-op. |
| Active head doubles as editable head | Simplest current model; inactive save stops future matching. Separate published/draft pointers are deferred, not simulated in UI. |
| Security/operability | No secrets/expressions in graph; retain body bounds, validate all input, avoid logging graph/name/scope payloads. Scope still is not authorization; no production readiness implied. |

## Implementation slices and measurable acceptance

1. **Backend contract/persistence:** implement schema/type and error contract, migration, NULL adapter, graph serialization and immutable revision insert in existing routes. Update generated automation schema from its source. Validate migration against pre-existing revisions and executions without changing their values; test immutability, raw insert activation guards, omission preservation, exact keys and 8192-byte limit. No worker feature change.
2. **Frontend compatibility/editor:** deploy transitional readers, then implement create/open/edit/save using graph-aware API and existing navigation/race protections. Retain IDs and positions; show saved revision and dirty state, validation details, conflict recovery and explicit activation/deactivation. Catalog restrictions and placeholder warnings are contractual, not visual styling decisions.
3. **Integrated verification/review:** create inactive -> GET -> move/edit -> PUT -> fresh GET must preserve all IDs, positions and edges and increment revision exactly once per successful write. Two simultaneous saves with the same expected revision must yield one success and one 409 with no extra revision. Reject all listed malformed graph classes; permuting arrays must not change acceptance. Inactive placeholder saves must succeed, and activation through both graph-aware and legacy-omitting requests must fail without revision change. Successful two-node activation must still snapshot/execute the existing local receipt only; graph edits/deactivation must not mutate old execution revisions or cause rematching. Test stale GET, route changes, 400/404/409/413, ambiguous PUT/POST outcomes, old/new response parsing, and actual reload after process restart.
4. **Later independent PRs:** executable Condition, external HTTP/ViaCEP, branching, multi-action workflows, revision history and draft/published separation are explicitly excluded. Each needs approved contracts and failure semantics before enabling corresponding nodes.

Telemetry should count graph save attempts/results and validation codes, revision conflicts and activation denials, plus existing request latency/errors; correlate request ID and automation ID/revision in structured logs, not high-cardinality metric labels. Do not log full graphs. No latency/scale SLO or benchmark is claimed here.

Lead decision: the additive contract and migration sequencing are approved. The optional Condition placeholder may be persisted only while inactive and must remain clearly non-executable; ViaCEP and generic HTTP remain unavailable in this increment. Backend/frontend owners must agree on golden request/response/error fixtures and QA must exercise the matrix above before acceptance. No runtime validation or production rollout was performed as part of this ADR.
