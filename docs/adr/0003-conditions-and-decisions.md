# ADR 0003: Conditions and Decisions over pinned automation revisions

- Status: **Accepted by Lead** for this increment; implementation and production rollout are not thereby validated or approved
- Date: 2026-11-09
- Scope: One deterministic condition, one existing internal action, explicit termination; no general workflow engine
- Predecessors: [ADR 0001](0001-visual-automation-mvp1.md), [ADR 0002](0002-persistent-visual-workflow-graph.md)

## Evidence inspected

These are code observations, not runtime validation:

- [Graph validator](../../backend/src/graph.ts), [definition routes](../../backend/src/automations.ts), and [frontend validator](../../frontend/src/workflow-graph.ts) accept only v1's two-node receipt path or inactive three-node placeholder path. No config or ports exist. [Builder](../../frontend/src/WorkflowBuilder.tsx) has a non-executable placeholder and locks editing while active; edge identity currently omits ports.
- [006](../../backend/migrations/006_automation_graph.sql) adds nullable JSONB and an immutable-function CHECK; [007](../../backend/migrations/007_validate_automation_graph.sql) validates it separately. SQL NULL materializes legacy v1. [004](../../backend/migrations/004_automation_definitions.sql) restricts schema_version to 1 and forbids revision mutation.
- [Acceptance](../../backend/src/accept.ts) pins revision and relational types, not graph bytes. [005](../../backend/migrations/005_automation_executions.sql) supplies the immutable revision FK, unique event/automation pair, and nullable result. [Worker](../../backend/src/worker.ts) reads no graph, checks only schema/type, writes one event receipt and copies its result to every execution.
- [Event content](../../backend/src/contract.ts) is exactly `{type,target,message}`; all three are strings. Arbitrary payload, numeric and boolean event fields are **not currently ingestible**. Scope/key are identity, not content.
- [Retry policy](../../backend/src/retry-policy.ts) and [scheduler](../../backend/src/scheduler.ts) are event-scoped; [execution routes](../../backend/src/executions.ts) currently derive every status from that event. [Frontend API](../../frontend/src/automation-api.ts) uses strict shape parsers and hardcodes schemaVersion 1 in write helpers.

## Decision

Adopt **graph.version 2 and definition/execution schemaVersion 2 together** for executable conditions. Keep v1 exactly as accepted, including inactive placeholders and SQL NULL adaptation. A compatible v1 extension is rejected: v1 has exact keys and explicitly forbids predicates/ports; older workers would otherwise execute conditions unconditionally. An old worker rejects schemaVersion 2 as unknown rather than executing it, but can still block/ack its event: versioning is defense in depth, **not a substitute for consumer fencing**.

Reuse the existing worker, event lock, transaction, receipt, outbox, retry dispositions/publications, scheduler and ack-after-commit. No eval, functions, scripts, templates, dynamic imports, regex predicates, external actions, MCP or RAG are involved. No new broker, scheduler or per-node queue.

This ADR narrowly supersedes ADR 0002's executable-node restriction for v2, and ADR 0001's uniform execution-status projection: branch outcome may be reported per execution, but effects and retries remain event-atomic. Lead accepted graph/schema v2, FALSE status ignored, the independent baseline receipt, and the missing/null/type-error/operator semantics below. Lead also directed the backward-compatible optional public event data extension specified here to make typed conditions usable.

## Public event data contract

Extend `POST /events` additively, retaining event type `receipt.v1`, target `local-receipt`, dispatch version 1 and existing response/status codes. This is independent of definition/execution schemaVersion 2. Exact request keys: required `scope,idempotencyKey,type,target,message`, optional `data`; no other top-level keys or new event version field. Existing required-field validation remains unchanged (scope 1..64 and key 1..128 ASCII letters/digits/underscore/hyphen; message 1..1024 with its existing character restrictions). `data`, when supplied, must be a JSON object, including `{}`; explicit null, array or scalar at this root is HTTP 400, not omission.

```json
{
  "scope": "demo",
  "idempotencyKey": "numeric-true-1",
  "type": "receipt.v1",
  "target": "local-receipt",
  "message": "Condition test",
  "data": { "valor": 150, "cliente": { "ativo": true }, "observacao": null }
}
```

Exact persisted content (and `GET /events/:id` content) is `{type,target,message}` when data is absent, or `{type,target,message,data}` when present. Scope and idempotencyKey remain identity outside content. Do not default absent data to `{}` or null, project away fields, flatten objects, coerce types, or copy data into receipts/results/dispatch messages. `content(input)` must append data only for an own supplied property. The example's numeric predicate is `fieldPath:"data.valor",operator:"greater_than",expectedType:"number",expectedValue:100`; the path is not `valor` or `content.data.valor`.

### Allowed values and bounds

- Within data allow JSON objects, arrays, strings, finite binary64 numbers, booleans and null. No undefined, nonfinite values, functions, accessors or other non-JSON objects. Reject numeric overflow after parsing; numbers follow the evaluator's binary64 semantics, including precision rounding of decimal/large integer literals. Clients needing exact amounts must not assume decimal arithmetic.
- Every object key within data (including objects inside arrays) must be 1..64 ASCII characters matching `[A-Za-z_][A-Za-z0-9_]*`; reject the exact keys `__proto__`, `prototype`, `constructor` at every level. No dotted keys or empty keys. Data strings may be empty, at most 1024 Unicode scalar values, with no NUL/unpaired surrogate. Existing message restrictions are not relaxed by this rule.
- Retain the **8192-byte UTF-8 total request-body limit**, including whitespace/envelope: exceeding it is 413. Additionally limit validated data's compact JSON serialization (`JSON.stringify` of the parsed, validated value, UTF-8) to **4096 bytes**, including its braces; excess is 400. These are separate checks: a data object within its budget can still exceed total body size. Raw spelling/escapes/whitespace are bounded by the total limit, not preserved as content.
- Maximum container depth is **7**, counting data's root object as depth 1 and each child object or array as +1; scalar values do not add a container level. Thus a deepest object-only scalar path has at most 8 segments including `data`. Enforce this with bounded traversal before persistence. Empty containers obey the same limit. No separate array-length/property-count quota: their size is bounded by the byte budget. Field paths retain 1..8 segments, <=64 characters per segment, <=256 characters total, so not every deeply nested combination of long valid keys is addressable; reject an overlong predicate path rather than truncate it.
- Arrays **may be ingested and retained** but cannot be traversed, indexed, compared, or tested by exists. A condition encountering an array yields permanent invalid_condition_value; an unrelated array elsewhere in data does not invalidate scalar lookup. Likewise a final object value is invalid for any operator. Array order remains meaningful to stored content/idempotency.
- Duplicate JSON member names are unsupported producer input, but rejection is **not guaranteed**: the existing JSON parser loses duplicates before schema validation (typically retaining the last member). This increment adds no raw duplicate-key detector. Validation and equality operate on the parsed representation, not raw bytes; tests must document this limitation and must not claim duplicate detection or signing/canonicalization guarantees. Dangerous names visible after parsing are rejected; never evaluate or merge untrusted data into application objects.

Malformed JSON, wrong root/value/key/depth/size shape and nonfinite values return 400 through the event API's existing validation/error handling, not the automation issue envelope. Preserve event responses: first accept 202 `{id,replay:false}`, replay 200 `{id,replay:true}`, changed content 409 `{error:"idempotency_conflict"}`. Validation failure creates no event, snapshot or outbox record.

### Equality, immutability and compatibility

Use existing PostgreSQL JSONB content equality after validated parsing/serialization for `(scope,idempotency_key)`. Include the entire data object. Object order/whitespace and equivalent numeric spellings do not distinguish content; array order, types, changed nested values, and absent versus present data do. In particular omitted data and `data:{}` conflict for the same key, as do missing nested field and explicit null. Replays return the original event and pinned execution selection; never update content or rematch.

Persist data atomically with the original event/snapshot/outbox, in existing `events.content` JSONB: no new column or data backfill. The event identity/content update guard below covers data recursively by rejecting any content replacement. Retry reads that same immutable event plus pinned immutable revision; subsequent requests, definition changes and deactivation cannot change either input. Retain events/revisions while referenced work exists. GET echoes validated data only when originally present, without adding a default. Avoid logging payloads; the existing local-only, unauthenticated boundary still applies.

Old requests, stored events and receipts without data keep their exact content key set, old serialization construction/order where applicable, equality and behavior; no historical rewrite. JSONB already does not preserve original wire bytes or object ordering, so raw byte round-trip is not promised. Widen event request/response schemas and strict frontend readers together; keep the `receipt.v1` name because this is an optional additive field, not a change to existing required fields or receipt effects. An old API rejects data: deploy all acceptance writers with support before enabling producers, never strip data and retry against an old server. Retain data-aware APIs/readers on rollback so original data-bearing requests can replay safely. Existing v1 automations ignore data and produce unchanged receipts; v2 consumers still require the fencing specified below.

Frontend scope is limited to accepting an optional JSON object in the existing event submission flow and typed predicate configuration. Blank data entry means omission, literal `{}` means present empty data, `null` is a validation error. Offer `type,target,message` paths plus manual validated `data.*` path entry (for example `data.valor`, `data.cliente.ativo`); do not infer permanent schemas/types from a single sample. Expected type/value entry must preserve numbers/booleans/null, and exists has no expected controls. No connector, ingestion mapping engine, schema registry, payload dashboard or expanded event-history product is implied.

## Graph and predicate contract

All objects reject unknown keys. v2 retains graph keys `version,nodes,edges`, node ID/position bounds and round-trip rules from ADR 0002. Exactly four nodes: one `(trigger,receipt.v1)`, one `(condition,condition.v1)`, one `(action,record-receipt.v1)`, one `(end,end.v1)`. Only the condition adds required `config`; other nodes retain exactly `id,kind,type,position`.

Exactly four edges and this topology only:

```text
trigger -> condition --TRUE--> action -> end
                    --FALSE------------> end
```

Non-condition edges have exactly `source,target`. Condition edges have exactly `source,sourcePort,target`; `sourcePort` is uppercase `TRUE` or `FALSE`. Exactly one of each; no target ports. Edge identity is `(source,sourcePort-or-empty,target)`; no duplicate source port. End has indegree 2/outdegree 0; action 1/1; condition 1/2; trigger 0/1. Every node is reachable and reaches end. Reject cycles, dangling/self edges, additional nodes/edges, alternate branch destinations, branch swaps, joins except this end, nesting and disconnected drafts. Incomplete editor state remains local. Array order and position never affect execution. Unconditional workflows remain v1; v2 is not a new representation for every legacy graph.

Condition config is a strict discriminated union:

| Operator | Exact config keys | Expected type/value |
| --- | --- | --- |
| `exists` | `fieldPath,operator` | No expected fields permitted |
| `equals`, `not_equals` | `fieldPath,operator,expectedType,expectedValue` | `string`, `number`, `boolean`, or `null`; actual JSON value must match tag |
| `greater_than`, `less_than` | Same four keys | `number`; finite only |
| `contains` | Same four keys | `string` only |

Expected strings permit empty string and at most 1024 Unicode scalar values; reject NUL and unpaired surrogates. Numbers use finite IEEE-754 binary64 semantics, no coercion/epsilon; -0 equals 0. No promise of exact decimal or large-integer arithmetic. JSON nonfinite tokens/overflow and arrays/objects as expected values are rejected. Preserve existing 8192-byte request bound. These limits are input safeguards, not measured throughput requirements.

### Field paths and lookup

`fieldPath` is relative to stored `events.content`, not the HTTP envelope, execution, process environment or current definition. Grammar: ASCII segments `[A-Za-z_][A-Za-z0-9_]*` separated by literal dots, 1..8 segments, each 1..64 characters, total <=256 characters. No whitespace, brackets, array indices, escapes, JSONPath, wildcards or operators. Reject any segment exactly `__proto__`, `prototype`, or `constructor` (case-sensitive); property lookup is case-sensitive too.

Traverse only own data properties of plain JSON objects; never inherited properties or getters. Missing own key yields the distinguished internal MISSING sentinel. Encountering null or a scalar before the last segment yields MISSING. Encountering an array at any visited segment, or an array/object as the final value, yields permanent `invalid_condition_value`, including for `exists`. Objects may be traversal containers, never comparison values. Nonfinite runtime numbers are also permanent invalid values. Never stringify complex values or evaluate dynamic code. Runtime validation remains necessary even after save validation.

The path grammar is not a field-existence guarantee: unknown paths are legal and resolve to MISSING. The public data extension above enables real numeric/boolean/null/nested scalar predicates. Without data, `data.valor` resolves MISSING. Do not permit paths into scope, idempotencyKey or other HTTP-envelope metadata by treating it as content.

### Deterministic evaluation

Validate config before lookup, then reject invalid runtime values before applying this table. No truthiness, coercion, locale folding, trimming or Unicode normalization.

| Resolved value | `exists` | Equality / inequality | Ordered comparison | `contains` |
| --- | --- | --- | --- | --- |
| MISSING | false | Both false, including `not_equals` | false | false |
| null | true | Expected null: true / false; non-null expected: false / true | permanent incompatible type | permanent incompatible type |
| string/finite number/boolean | true | Expected null: false / true; otherwise same type required, strict equality / its negation | Both operands must be numbers | Both operands must be strings |
| array/object/nonfinite | permanent invalid value | permanent invalid value | permanent invalid value | permanent invalid value |

Different non-null scalar types are permanent `condition_type_mismatch`, even for `not_equals`; do not turn malformed inputs into successful branches. `contains` is case-sensitive contiguous substring matching; empty expected string matches every string. `greater_than` and `less_than` are strict, so equality gives false. Null is an explicit value; MISSING is never serialized as null. `not_equals` is the negation of equals **only for present, compatible operands**. Evaluation returns boolean or a typed permanent error, never an implicit false on error.

## Persistence, outcomes and atomicity

Read graph from the **pinned** `(automation_id,revision)` FK when processing; never join the current revision pointer. Revalidate schema/graph/projection and config. SQL NULL is executable only with schemaVersion 1. v2 requires non-NULL graph v2, fixed matching relational trigger/action projection and full executable topology. Unknown versions/types fail closed. Preserve snapshot selection/replay behavior; no rematching on retry, activation, edit, deactivation or restart. Event content must remain unchanged after acceptance; current schema does not enforce that immutability, so add a guard for updates to event identity/content while allowing existing cleanup deletes.

Persist v2's decision and result in existing `automation_executions.result`, using the exact envelope below. No graph duplication and no new execution lifecycle table. v1 keeps its existing `local-receipt.v1` result (or NULL); do not rewrite historical rows. Envelope fields are always present:

```json
{
  "kind": "condition-execution.v1",
  "eventId": "00000000-0000-0000-0000-000000000001",
  "decision": {
    "nodeId": "condition",
    "outcome": "FALSE",
    "sourcePort": "FALSE",
    "targetNodeId": "end"
  },
  "action": { "nodeId": "action", "status": "ignored", "receipt": null },
  "failure": null
}
```

- `decision` is null if no predicate verdict was obtained, otherwise exactly `nodeId,outcome,sourcePort,targetNodeId`; outcome and port must agree (`TRUE`/`FALSE`), target must equal the pinned edge. Do not include actual/expected values or event payload in decision metadata. The pinned revision remains the predicate audit source.
- `action` is exactly `nodeId,status,receipt`. Status: `pending`, `executed`, `ignored`, `not_executed`. `executed` requires TRUE and a receipt with the existing exact `{kind:"local-receipt.v1",eventId,message}` shape; all other statuses require receipt null. `ignored` requires FALSE. `pending` is TRUE with retryable failure. `not_executed` is an unresolved/error verdict or TRUE with terminal event failure. Node ID is the pinned action ID; null is permitted only when corrupt/unsupported pinned content prevents identifying it.
- `failure` is null or exactly `{classification,code,nodeId}`. Classification: `transient`, `permanent`, `unknown`, `exhausted`. Code allowlist: `invalid_condition_config`, `invalid_condition_value`, `condition_type_mismatch`, `unsupported_execution_contract`, `action_transient`, `action_permanent`, `action_unknown`, `event_peer_failure`, `retry_exhausted`. nodeId identifies the failing local node, otherwise null (peer/baseline/unsupported graph). No arbitrary exception prose. FALSE always has failure null, even if a peer fails.
- Before first committed evaluation, result is SQL NULL. Failed attempts may commit verdicts and failure metadata without action effects. A retry replaces pending/failure metadata atomically; it must reproduce the same predicate decision from the unchanged inputs. Successful/ignored terminal outcomes must not be rewritten on duplicate delivery. This is latest disposition history, **not** an attempt log or per-node timeline.

### Worker flow and the baseline receipt

1. Retain event `FOR UPDATE`, dispatch/generation validation, stale-publication checks and idempotent terminal return. Load all executions and pinned graphs in deterministic execution-ID order. Evaluate every v2 condition without side effects. FALSE is a successful decision, not an error or retry reason.
2. The existing unconditional event target `local-receipt` remains separate from automation eligibility. Even zero selected executions or all FALSE still complete the baseline event receipt. A TRUE automation executes the existing receipt action; identical internal effects share the unique `receipts(event_id)` row. Therefore existence of that row **does not prove** that any particular automation action ran. Only its execution result does. No external delivery is implied.
3. Collect failures and feed one aggregate outcome to existing `decideRetry`: permanent precedes unknown, then transient, otherwise success. FALSE contributes success. Attribute the actual failure to its execution; TRUE peers use `event_peer_failure` with the aggregate classification. Baseline failure affects all TRUE peers. Unknown unsupported pinned contract is nonretryable `unknown`, not success.
4. If every required action and baseline succeed, commit the receipt and TRUE executed/FALSE ignored results with completed disposition. If any fails, roll back **all action effects** (use an action savepoint if effects were staged), then commit decisions, failure results and the existing retry/blocked disposition in the same outer event transaction. No TRUE result can claim executed after rollback. FALSE can remain ignored while the event retries a peer; this is a decision observation, not partial action completion.
5. Transient failure uses existing bounded backoff (current default 3 attempts, 1000 ms base, 60000 ms cap), publications and relay; terminal exhaustion sets TRUE actions not_executed, classification exhausted/code retry_exhausted. Invalid config/value/type is permanent and never scheduled. Existing blocked records are the durable recovery surface; do not claim a broker DLQ or manual replay endpoint exists.
6. Mark retry publication processed and ack only after commit as today. Before-commit crash rolls back both decisions and effects; after-commit/pre-ack crash redelivers and performs no duplicate effects/result mutation. DB/connection exceptions without a trustworthy committed disposition roll back and remain unacked; do not misclassify infrastructure failure as a condition false. Such infrastructure redelivery is not automatically bounded by the handler retry budget.

Recompute a pure decision on retry (or verify an already stored decision against the same revision); never read mutable external state. Keep event identity uniqueness `(scope,idempotency_key)`, execution uniqueness `(event_id,automation_id)`, receipt uniqueness `event_id`, and generation idempotency. Same-key/same-content replay returns the original event/snapshot; conflicting content remains conflict. No exactly-once-delivery guarantee, new per-execution retry budget or independent successful-action progress is introduced.

## API, history and frontend agreement

Definition routes, optimistic revisions, scope immutability, limits and transport errors remain ADR 0002's contract. v2 POST/PUT must include full graph and schemaVersion 2; creation is still inactive. Graph omission is allowed **only when effective/current schema and requested schema are both 1** (POST omitted graph defaults to v1); any v2-related omission returns 400 `graph_required`. A graph1/schema2 or graph2/schema1 pair is `execution_schema_mismatch`. Explicit full replacement back to v1 is allowed only when inactive; it removes the condition only in the new revision, never in pinned work. No automatic placeholder conversion: preserve IDs/positions where applicable, require a user-chosen predicate and both branches/end, then save a new inactive v2 revision.

Retain ADR 0002 shape -> identity -> cardinality -> cycle -> topology -> projection -> activation stages and deterministic issue sorting. Config grammar/type checks occur in shape validation before lock; graph/schema pairing in projection after expectedRevision conflict. Add `invalid_condition_config`, `invalid_field_path`, `invalid_expected_value`, `invalid_source_port`, `graph_required`, `execution_schema_mismatch`, `conditions_disabled` to the issue code vocabulary. Paths use JSON Pointers into config/edges; keep issue keys unchanged. Unsupported graph version still takes precedence. A feature-disabled v2 save/activation returns `conditions_disabled`; reading pinned v2 remains supported. Runtime failures are execution results, not asynchronous HTTP validation responses.

Execution endpoints keep existing top-level keys, list filters/order/100-item limit and retry object; widen schemaVersion/result unions, and add status `ignored` only for v2 FALSE. **Status precedence**: FALSE -> ignored; otherwise parent retry_released/retry_scheduled/blocked; otherwise parent completed -> completed only with executed result; otherwise accepted if result NULL and no disposition. Inconsistent persisted combinations must fail closed/log an invariant violation, never synthesize success. v1 retains its legacy status/result rules. `retry` remains the parent event's disposition even for ignored execution; UI must label it event-level so ignored+parent blocked is not contradictory.

History displays pinned revision, condition node, TRUE/FALSE target, action executed/ignored/not executed/pending, failure classification/code and event retry metadata. A current graph is not historical execution evidence. No revision-history endpoint is added in this slice: result gives branch identity; full historical config inspection remains deferred. Unknown versions must render unsupported/read-only without coercion/downgrade (strict old parsers currently fail the list; upgrade them first). Preserve existing response fields for v1 and update generated schemas and golden fixtures together.

Frontend owners must map handles to exact `sourcePort`, use port-aware edge IDs, validate typed inputs without converting numbers/booleans to strings, hide expected inputs for exists, and keep incomplete edits local. Preserve stable IDs, saved/dirty separation, inactive editing, explicit save/activate, conflict/race and ambiguous-write handling. Toggle/save helpers must preserve loaded schemaVersion/graph instead of spreading the current fixed v1 fields. No fallback retry omitting v2 graph. This defines interaction/data requirements, not a UI design.

## Additive migration and rollout

Do not edit 004/005/006/007 or mutate immutable revisions. Proposed next migrations (numbers reserved only after Lead checks concurrent work):

1. Expand definition schema_version CHECK to 1 or 2; retain trigger/action allowlists. Add a **new versioned guard function and CHECK** accepting exact v1 legacy rules or strict v2 rules with schema pairing, including inactive graphs. Do not merely replace the body of the IMMUTABLE function referenced by the validated 006 CHECK: previously checked rows would not be revalidated automatically. Add new CHECK NOT VALID and remove old CHECK atomically; validate in a separate migration/transaction as 007 did. SQL NULL graph allowed only for schema1. Test direct SQL bypasses and JSON null/missing keys.
2. Add result-envelope/pairing validation for schema2 executions and immutability of execution snapshot identity fields; allow result updates only for processing, not changing event/revision/types. Permit legacy schema1 rows/results unchanged. Add event identity/content update guard. No result backfill, graph copy, new state column or new queue is required. DB checks enforce local shape/enums; worker enforces pinned-node/branch correspondence under the event lock. Verify existing data before validating constraints; report violations, never silently repair snapshots.
3. With condition writes default-off, deploy widened readers and worker runtime; disable/fence **all old definition writers and workers** before enabling v2 writes or activation. Existing acceptance gate remains independent. Confirm worker capability using deployment inventory plus an isolated smoke test, not just a UI flag. A gate name/wiring is an implementation choice; it must reject both v2 creation and updates until readiness is verified.
4. Deploy bounded data-aware event acceptance and GET schema/readers across all API writers before enabling data entry/producers; verify absent-data replay compatibility. Enable v2 writes, then explicitly activate tested revisions. Existing pinned v1 remains on its legacy path. Validate mixed v1/v2 executions for a single event and real public data predicates. Only the optional data contract above is enabled, not broader connector/ingestion capabilities.
5. Rollback: disable v2 writes/activation, optionally deactivate current v2 heads via a graph-aware operator path, and retain v2-capable worker/readers until pinned v2 work and blocked/retry records are resolved. Gate-off deactivation must remain allowed for an unchanged v2 graph; predicate edits/activation remain denied. Do not downgrade workers/DB or erase v2 rows to recover. No deployment or production permission is granted here.

## Alternatives, risks and remaining constraints

| Choice/risk | Recommendation / consequence |
| --- | --- |
| Extend v1 without schema bump | Reject: exact-key break and unconditional execution by existing worker |
| v2 graph plus schema2 | Small explicit fence; requires migrations and coordinated clients/consumers |
| General DAG/multiple actions | Defer: no evidence warrants independent scheduling, fanout or joins |
| Per-execution retries | Reject for this slice: would replace event atomicity and scheduler semantics |
| False means no event receipt | Reject by default: existing target_snapshot/receipt path is unconditional; requires a separate baseline behavior decision if desired |
| Type mismatch returns false | Reject: hides invalid configuration/input; permanent failure is visible but can block TRUE peers |
| Persist observed values | Reject: unnecessary payload duplication and privacy risk; retain branch and pinned revision |
| Retention and mutation | Pinned revisions/events must outlive pending work; new guards require cleanup/regression tests |

Lead decisions are recorded above; optional bounded data resolves the typed-public-input blocker. Duplicate-key detection and exact-decimal arithmetic remain explicitly unsupported; broader connectors/dashboard work remains out of scope. No SLO, throughput, multi-tenant authorization or production guarantee is inferred. Existing scope is not authorization. Blocked-config recovery requires fixing a new revision and deliberately submitting a new event identity; no automatic replay/rematch of an old snapshot is allowed. A future administrative retry/cancellation mechanism needs its own contract. Implementation review, migration sequencing and operational rollout evidence remain required.

## Implementation slices and acceptance evidence

1. **Backend contracts/migrations:** versioned graph/config validators, bounded optional event data validation/content serialization, event request/GET schema updates, new DB guards, schema/result unions and generated fixtures; validate migration on legacy NULL graphs, placeholders, active v1, existing execution results and direct SQL v2 violations. Verify absent-data compatibility and whole-content idempotency; no revision/content mutation.
2. **Evaluator/worker:** bounded safe lookup and operator table; pinned joins, decision/result recording, aggregate retry and action savepoint. Run the [validation matrix and examples](../architecture/conditions-and-decisions-validation.md), including event baseline/all-FALSE behavior and v1/v2 atomicity. No new scheduler/relay behavior.
3. **Frontend/API history:** typed config/ports/end handling, strict dual-version readers/writers, ignored/permanent/transient presentation, read-only unsupported data, stale/conflict and reload tests. Backend/frontend/QA agree golden fixtures before activation.
4. **Rollout proof:** isolated create -> save -> reload -> activate -> accept -> TRUE/FALSE history; restart/redelivery and retry while later revisions change. Independently review failure/immutability/fencing tests before Lead accepts implementation.

Telemetry: count decision TRUE/FALSE/error and action executed/ignored, failure code/class, scheduled/blocked/exhausted, invariant violations and version/activation denials. Log correlation event/execution/automation/revision/node/generation/attempt; do not use IDs as metric labels or log full graphs/field values. Existing request/retry telemetry remains. No benchmarks or runtime validation were performed for this documentation contract.
