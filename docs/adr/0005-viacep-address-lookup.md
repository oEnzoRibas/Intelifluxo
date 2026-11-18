# ADR 0005: Persisted ViaCEP observation before Conditions

- Status: **Accepted for the local controlled v0.1.0 slice**; not deployment or production-use approval
- Date: 2026-11-10
- Scope: Stage 2, real block **Consultar Endereço por CEP**
- Predecessors: [0001](0001-visual-automation-mvp1.md), [0002](0002-persistent-visual-workflow-graph.md), [0003](0003-conditions-and-decisions.md), [0004](0004-automation-list-dashboard.md)

## Evidence, assumptions and minimal boundary

Inspected all four ADRs, migrations 001–012, graph validators, condition evaluator, acceptance, execution persistence/readers, worker, scheduler/retry policy, API schemas/configuration and existing regression test coverage. These are source observations, not successful runtime validation:

- [graph-v2.ts](../../backend/src/graph-v2.ts) and migration 009 require exactly four nodes and four edges. Only trigger, condition, receipt action and end are executable. Adding a fifth node to v2 is not compatible.
- [condition.ts](../../backend/src/condition.ts) resolves only immutable event content, using bounded own-property paths. Its missing sentinel differs from null; arrays/objects are invalid final values. No step namespace exists. Node IDs permit hyphens, while field-path segments do not: do not encode node IDs inside dotted paths.
- [worker.ts](../../backend/src/worker.ts) holds the event row lock throughout one transaction, reads pinned revisions, evaluates conditions, aggregates outcomes, and commits receipt/results/disposition together. It currently does **not** load prior execution results for reuse and has no HTTP handler. Its failure evaluation union must gain transient outcomes.
- [execution-result.ts](../../backend/src/execution-result.ts), [executions.ts](../../backend/src/executions.ts) and SQL result guards accept only v1/v2. A pending v2 action requires an already-TRUE decision; a lookup waiting before a decision cannot fit that envelope.
- [accept.ts](../../backend/src/accept.ts) snapshots active revisions once. Same identity/content replay returns the old event, without rematching. Migration 008 makes event content and execution identity immutable. Migrations 009–012 enforce graph/result and target pairing; they cannot simply be bypassed for the new version.
- [retry-policy.ts](../../backend/src/retry-policy.ts) is deterministic exponential backoff without jitter; production [worker-main.ts](../../backend/src/worker-main.ts) supplies no override, so defaults are three event attempts, 1000 ms base, 60000 ms cap. [scheduler.ts](../../backend/src/scheduler.ts) releases event generations using existing dispositions/publications; relay and ack-after-commit already exist. Blocked records are the recovery surface, not a claimed broker DLQ or manual replay API.
- Existing tests include conditions, graph/API/SQL guards, mixed-version workers, retry/scheduler generations, process-crash recovery, event data, execution invariants and configuration. Tests are not evidence of ViaCEP support. The explicit `test:integration` package script does not list every integration file; new suites must be explicitly included in verification.
- Definition API writes, strict frontend readers and the new summary list currently support versions 1/2 only. Published execution schema drift already exists: `execution-v1.schema.json` omits runtime `ignored` and retry `scope`, while its schemaVersion is an unrestricted integer. Reconcile actual runtime unions and published schemas rather than assuming that file proves v2 parity. Scope is not authorization. This is still local-only, unauthenticated, synthetic-data software.

**Minimal necessary extension:** a graph/execution version, a fixed outbound-read adapter, persisted reusable observations, and a versioned condition input selector. A catalog-only node or browser-side lookup cannot satisfy real persisted Trigger → ViaCEP → Condition → Action execution. No general DAG engine, separate broker, scheduler, generic HTTP action, MCP or RAG is required.

Assume one lookup and one condition per new workflow, with the existing local receipt action. No remote write action or customer-data production use is approved. The numbers below are safety limits proposed here, not measured capacity or SLOs. Lead approval is needed for the new outbound boundary, version bump and transaction-lock trade-off before enabling writes.

## Decision and alternatives

Adopt **graph.version 3 paired with schemaVersion 3**, preserving all v1/v2 behavior. The ViaCEP node is `kind:"lookup",type:"viacep-address.v1"`; the condition is `kind:"condition",type:"condition.v2"` because it adds an explicit input selector. Relational trigger/action remain `receipt.v1` / `record-receipt.v1`. No alternate endpoint, provider fallback, address search, credentials or arbitrary headers.

| Option | Decision / consequence |
| --- | --- |
| Extend v2 in place | Reject: exact topology/keys and old worker semantics are incompatible; bypassing guards is unsafe. |
| New bounded v3 and persisted observation in existing result | Select: explicit compatibility fence, small executor extension, no independent step lifecycle. |
| Requery every retry | Reject: a changed provider response could change an already committed decision. |
| Separate lookup checkpoint transaction/table and leased execution | Defer: reduces long event locks but needs ownership/fencing, crash windows and recovery contracts beyond this slice. |
| Generic HTTP node or per-step queues | Reject: unnecessary endpoint/security/configuration and orchestration surface. |

## Graph and input contracts

Retain graph exact keys `version,nodes,edges`, stable IDs, positions, bounds, edge rules and staged issue sorting from ADR 0002. Exactly five nodes and five edges, with only this topology:

```text
trigger → lookup → condition --TRUE--> action → end
                            --FALSE------------> end
```

Non-condition edges have exactly `source,target`. Condition edges add required `sourcePort` (`TRUE` or `FALSE`). No optional lookup, parallel lookup, loop, joins except end, branch swap or incomplete stored draft. Array order never controls execution. Other nodes retain exact `id,kind,type,position`; lookup and condition additionally require `config`.

Lookup example (position illustrative):

```json
{
  "id": "address-lookup",
  "kind": "lookup",
  "type": "viacep-address.v1",
  "position": { "x": 180, "y": 0 },
  "config": { "cep": { "source": "event", "fieldPath": "data.cep" } }
}
```

`config` has exactly `cep`. `cep` is exactly one of:

- `{"source":"fixed","value":"01001000"}`;
- `{"source":"event","fieldPath":"data.cep"}`.

Fixed values and runtime event values use the same strict normalization: accept **strings only**, either exactly eight ASCII digits or exactly five ASCII digits, one ASCII hyphen, three ASCII digits. Remove that single permitted hyphen to obtain eight digits. No trim, arbitrary non-digit removal, numeric conversion, Unicode digits, signs, whitespace, newline suffix, partial matching or zero-padding. Leading zeros survive. `00000000` is syntactically valid, not evidence of existence. Preserve the submitted fixed string in its immutable graph; normalize only the request/input observation. Validate fixed format at save; event-field existence/type/format at execution. Paths follow ADR 0003 grammar and resolve relative to `events.content`; missing, null, arrays, objects, numbers and booleans are invalid CEP inputs, not requests.

Condition v2 config replaces v1's top-level `fieldPath` with required `input`; operator/expectedType/expectedValue and exact-key operator unions otherwise retain ADR 0003 rules:

```json
{
  "input": {
    "source": "step",
    "nodeId": "address-lookup",
    "fieldPath": "address.uf"
  },
  "operator": "equals",
  "expectedType": "string",
  "expectedValue": "SP"
}
```

`input` is exactly `{source:"event",fieldPath}` or `{source:"step",nodeId,fieldPath}`. Event input keeps v2 event semantics. Step input must reference this graph's sole preceding lookup ID, validated on save and runtime; no forward/cross-execution reference or dynamic node ID. Its root is the persisted lookup object described below. Recommended paths: `address.logradouro`, `address.bairro`, `address.localidade`, `address.uf`, `address.cep`; unknown syntactically valid paths resolve MISSING. Keep the same <=8 segments, <=64 characters per segment, <=256 total, forbidden names, own-property-only traversal and scalar-only operators. Reuse the pure scalar evaluator after selecting the root, not a second operator implementation. No merge of provider data into `events.content` and no `steps.<node-id>` string interpolation.

Empty present address fields remain `""`: `exists` returns true, equals empty returns true. Absent fields remain omitted: `exists` and both equality/inequality return false. Explicit null from the provider is **not** an absent field; it fails payload validation below. Conditions run only after a `found` lookup, including event-source conditions; not-found/error never implicitly selects FALSE.

## Provider response and persisted result

Use exactly `GET https://viacep.com.br/ws/{normalizedCep}/json/`, no query string. Official [ViaCEP documentation](https://viacep.com.br/) retrieved through Context7 on 2026-11-10 specifies eight digits, invalid-format HTTP 400, not-found `erro:true`, and these sample fields:

`cep,logradouro,complemento,unidade,bairro,localidade,uf,estado,regiao,ibge,gia,ddd,siafi`.

On HTTP 200 require a bounded JSON object. Success requires `cep` in one of the accepted formats, normalizing equal to requested CEP, and no `erro` member. Require only `cep`; other expected fields may be absent or empty. Every supplied allowlisted field must be a string of <=1024 Unicode scalar values without NUL/unpaired surrogate. Preserve returned strings, including formatted `cep`, whitespace and empty values verbatim; retain leading zeros in codes such as `ibge`/`ddd`, never convert them to numbers. A missing `uf` is not silently manufactured and cannot make an `exists address.uf` condition true.

Project only own properties from the above fixed allowlist into a new plain address object, never spread/merge provider objects. Unknown fields are ignored within the body budget and never persisted or exposed. Reject dangerous own keys `__proto__`, `constructor`, `prototype` at the root; nested unknown content is ignored, not traversed or evaluated. `erro` is a reserved marker: exact boolean true with **no address fields** is not-found (unknown non-address fields may be ignored); false, strings such as `"true"`, null or mixed `erro:true` plus address fields are unexpected payload. Non-200 responses never become found/not-found based on their bodies. Standard parsed-JSON duplicate-name limitations remain: no duplicate detection or raw-byte preservation guarantee.

Persist in existing `automation_executions.result`, not event content and not a new queue/table. v3 result has exactly `kind,eventId,lookup,decision,action,failure`:

```json
{
  "kind": "viacep-condition-execution.v1",
  "eventId": "00000000-0000-0000-0000-000000000001",
  "lookup": {
    "nodeId": "address-lookup",
    "kind": "viacep-address-result.v1",
    "status": "found",
    "cep": "01001000",
    "address": { "cep": "01001-000", "logradouro": "Praça da Sé", "uf": "SP", "complemento": "" },
    "failure": null
  },
  "decision": { "nodeId": "condition", "outcome": "TRUE", "sourcePort": "TRUE", "targetNodeId": "action" },
  "action": { "nodeId": "action", "status": "executed", "receipt": { "kind": "local-receipt.v1", "eventId": "00000000-0000-0000-0000-000000000001", "message": "Address lookup test" } },
  "failure": null
}
```

The example deliberately omits expected fields: serialization must not default them to null or empty string. Lookup keys are always exactly `nodeId,kind,status,cep,address,failure`:

- `found`: canonical eight-digit cep, projected address object (required matching returned cep), failure null.
- `not_found`: canonical cep, address null, failure `{classification:"permanent",code:"viacep_not_found",nodeId:<lookup ID>}`.
- `failed`: address null; canonical cep if locally valid, otherwise null; failure with classification/code below. Never persist rejected raw CEP or provider/error body.
- `lookup:null` only for an unsupported/corrupt graph preventing safe identification/evaluation, with top-level `unsupported_execution_contract` failure. Before the first committed attempt, entire result is SQL NULL.

`decision` and `action` retain ADR 0003 shapes. For v3 only, `pending` may have decision null when lookup is retrying, as well as TRUE when a peer/action retries; it requires transient top-level failure and no receipt. `not_executed` requires terminal failure and null or TRUE decision. `ignored` requires FALSE, null failure/receipt; `executed` requires TRUE, matching action target, null failure and receipt. Unknown graph may have null action node; valid graphs may not. A FALSE observation is ignored even if a peer blocks, as today.

Top-level failure uses exact `{classification,code,nodeId}` and existing classifications/codes plus the ViaCEP codes below. For a non-found lookup, the top-level failure exactly mirrors its own lookup failure unless a strictly stronger peer failure applies: transient may be overridden by unknown, permanent or exhausted; unknown may be overridden by permanent. Ties retain the lookup's own failure; permanent and exhausted cannot be overridden. An approved override retains the lookup diagnostic and uses top-level `event_peer_failure` with the stronger classification and null nodeId; action is not_executed, not pending. In particular, an unknown `viacep_unknown` lookup remains unchanged under a permanent peer. Exhaustion is a retry disposition over raw transient, not a new raw lookup failure: at the maximum attempt, an own transient lookup is canonicalized to `exhausted/retry_exhausted` at the lookup ID in both lookup and top-level failures. When lookup found but downstream/peer fails, keep lookup unchanged and attribute top-level failure to condition/action/peer. A lookup's address and status must never imply that the action executed.

## Failure disposition and bounded retry

| Observation | Classification / code | Behavior |
| --- | --- | --- |
| Invalid local value, missing path, unsafe runtime source | permanent / `invalid_cep` | No DNS or HTTP; condition/action not executed. Invalid fixed input instead fails save. |
| HTTP 200 and valid `erro:true` marker | permanent / `viacep_not_found` | Persist not_found, block event, no retry, no condition evaluation. Not a successful FALSE branch. |
| Deadline exceeded | transient / `viacep_timeout` | Abort request/body; existing event retry budget. |
| Temporary DNS failure, connection reset/refused, truncated transfer | transient / `viacep_transport` | Existing budget; no immediate client retry. |
| HTTP 429 or 500–599 | transient / `viacep_http_transient` | Existing budget; discard bounded body; do not log it. |
| Other non-200 status, including 3xx, 400/404 and 408 | permanent / `viacep_http_permanent` | No redirect or retry; HTTP 404 is not CEP not-found. |
| Invalid JSON/UTF-8, wrong content type, wrong root, invalid fields/marker, mismatched CEP, body too large | permanent / `viacep_invalid_response` | Controlled blocked failure, no condition/action; never stringify arbitrary error text. |
| Forbidden DNS destination or TLS certificate/hostname validation failure | permanent / `viacep_security_rejected` | No insecure retry/fallback. |
| Unrecognized adapter exception or unsupported execution contract | unknown / `viacep_unknown` or existing `unsupported_execution_contract` | Fail closed, blocked; do not assume success or infinite retry. |

Aggregate all executions and baseline as today: permanent precedes unknown, then transient, then success. Own failures retain attribution; non-ignored peers use event_peer_failure. Mixed classifications may therefore block an event without consuming every transient lookup's potential retry. Preserve independent baseline receipt semantics: all FALSE can still create the baseline receipt; any failure prevents **all** receipt effects for that attempt. Do not bypass baseline semantics to claim no receipt on FALSE.

Use existing `decideRetry`, dispositions, scheduler, publications, relay and dispatch version 1 unchanged. One outbound attempt per unresolved lookup per **event attempt**. Three total committed event attempts, delays 1000 then 2000 ms (60000 ms cap remains existing policy), no adapter retry, sleeps, new retry topic or per-step budget. `Retry-After` is ignored in this bounded local slice rather than implementing a parallel timing policy; no provider quota compliance or fleet-wide rate limit is claimed. On exhaustion block with exhausted/retry_exhausted; retain prior found observations. DB failures/crashes before disposition commit remain unacked infrastructure redelivery and are not bounded by this handler budget. Recovery of terminal invalid/not-found work requires deliberately submitting a new identity after correction; editing a head does not repair pinned work.

## Transaction, replay and determinism

1. Keep current event lock, generation/publication evidence checks and terminal return **before any network call**. Load pinned graph, immutable event content **and prior results**, in execution-ID order. Validate saved observation shape and pinned node/CEP correspondence; corrupt prior results fail closed, never silently fetch a replacement.
2. For each supported v3 execution, reuse a previously committed found observation; never refresh by TTL or provider drift. Otherwise resolve/normalize input, perform at most one bounded lookup and capture the observation. Process sequentially, avoiding unbounded parallel outbound requests. Continue evaluating peers so results/disposition attribution remain coherent.
3. Evaluate condition from immutable content or captured lookup; recompute from that same frozen input on retry, optionally verify saved verdict equality. Do not use live definition, current provider data, time or environment as predicate data. Existing v1/v2 routes remain unchanged.
4. Only after collecting outcomes write internal receipt effects if aggregate success. If an implementation stages effects earlier, use the existing architectural savepoint rule and roll them all back on failure. Persist observations, decisions, result failures and one event disposition in the same outer transaction, including found observations when a peer forces retry/block. Mark retry publication processed and ack only after commit.
5. A crash before commit may repeat GET and see changed provider data; **the first committed valid observation wins**, not the first HTTP response. A crash after commit/pre-ack returns through existing dedupe with no new request or mutation. Same event HTTP replay, duplicate deliveries, retry generations, process restarts and later revision changes all reuse committed observation/snapshot. Different executions/events may independently query the same CEP and observe different data; no shared cache or cross-execution equality guarantee.

Add a v3-only result update guard preventing replacement/removal of a committed found lookup and mutation of terminal executed/ignored results. Pending/failed metadata may change with processing; snapshot identity remains immutable. Terminal lookup errors have no retry path in this slice. SQL validates shape and frozen JSON; worker validates correspondence to pinned graph/input under event lock. Do not claim exactly-once GET or external side effects: GET is a repeated read, with potential provider quota/logging effects, and network calls cannot be rolled back.

**Lock trade-off:** network I/O now extends the event transaction. With N unresolved selected lookups, outbound time alone may approach N × timeout; no match-count limit exists in acceptance. Prefetch 1 bounds one worker's deliveries, not fleet load or per-event lock duration. This is sufficient only for the existing local controlled demo. If requirements include a bounded end-to-end event deadline, high fanout, production isolation, or preserving responses across pre-commit crashes, stop and approve a separately fenced observation-checkpoint/lease design; do not claim this slice supplies those guarantees. No throughput benchmark has been performed.

## Outbound security and configuration

Server owns scheme `https`, hostname `viacep.com.br`, port 443, method GET and path template. Only canonical digits enter the path. No URL/host/port/header/proxy/credential graph fields or endpoint environment override. Browser never contacts ViaCEP on behalf of workflow execution. Do not introduce authentication or tenant headers.

- Total deadline defaults to **5000 ms**, covering DNS, connection, TLS, headers and body. Abort and destroy transport resources on timeout; a simple promise race leaving a socket active is insufficient.
- Maximum response body **16384 bytes**, checked from declared Content-Length when present and cumulatively while streaming; reject the first byte beyond bound. Request `Accept: application/json` and `Accept-Encoding: identity`; reject non-identity content encoding, avoiding decompression bombs. Accept media type application/json with optional parameters. Decode UTF-8 strictly, then parse bounded JSON; no JSONP, scripts or HTML. Header budget is at most 16384 bytes. Bound/discard error bodies too; never read unbounded text for diagnostics.
- Disable redirects entirely, including same-host redirects. Keep certificate chain and hostname verification enabled. TLS SNI and Host remain the fixed hostname even when connecting to an approved IP.
- Resolve with a deadline and validate **every returned address** as globally routable unicast. Reject if any answer is loopback, unspecified, link-local, private/ULA, carrier-grade NAT, multicast, reserved/documentation or otherwise special-use; normalize IPv4-mapped IPv6 before checking. Use a reviewed address-classification library or exhaustively tested implementation against current special-use ranges, not prefix guesses. Fail closed on an empty set or invalid addresses.
- Bind the actual socket connection to an approved resolved address via the transport's controlled resolver/connector; do not validate DNS then let the client resolve again. Validate the connected remote address too. Revalidate fresh resolutions on later attempts; forbid ambient proxy routing and implicit redirect/retry behavior. Test all candidate-address/family fallback behavior. Infrastructure egress controls are additional defense, not a replacement. If the selected client cannot enforce these requirements, block enablement rather than silently weaken them.

Configuration contract (new configuration, not currently implemented):

| Name | Default / validation | Scope |
| --- | --- | --- |
| `VIACEP_WRITES_ENABLED` | false; exact `true`/`false` only | API saves/activation of v3. Reads and execution of pinned work never depend on this gate. |
| `VIACEP_TIMEOUT_MS` | 5000; canonical decimal integer 1000..10000 | Worker total HTTP deadline; invalid value fails startup. |
| Body/header limits, host, TLS, redirect policy | Fixed constants above, not configurable | Cannot disable security controls per workflow/environment. |
| Retry policy | Existing production defaults, not new ViaCEP env settings | Retain policy test seam only; no per-node overrides. |

Require existing `CONDITIONS_WRITES_ENABLED` and new ViaCEP gate for v3 create/edit/activation; `AUTOMATION_SNAPSHOTS_ENABLED` remains independent for acceptance. Gate-off unchanged-graph deactivation remains allowed; flags never cancel pinned work. Use default-off plus deployment inventory to establish capability; a feature flag is not worker fencing. Do not add a runtime-off flag that silently skips already pinned lookups.

Never log CEP, address, event data, graph/config, full URL (path contains CEP), response body/headers, resolver answers, raw exceptions or credentials. Disable/redact HTTP instrumentation that would automatically record these. Persist projected address intentionally for execution history; no extra raw-body archive, hash-indexed cache or permanent logs. Existing local/synthetic boundary and retention of referenced work remain; production privacy/access-control/retention policy is unresolved and not inferred from scope.

## API, migrations and rollout

Keep definition routes, inactive create, full replacement PUT, expectedRevision conflict and 8192-byte request limit. v3 requires full graph; omission remains legal only when both current/requested versions are 1. Reject mismatched graph/schema. Downgrade to v1/v2 requires an explicit inactive full replacement, never mutating old pinned revisions. Add validation codes `invalid_cep_config`, `invalid_cep`, `invalid_condition_input`, `invalid_step_reference`, `viacep_disabled`; retain invalid_field_path/config and existing stage order/JSON Pointer envelope. Unknown config keys, source variants, endpoint attempts and additional nodes must reject without writing a revision. Gate denials use path `/graph`; CEP/config errors point into the relevant node config. Stale well-shaped PUT still conflicts before semantic validation.

Execution endpoints retain top-level shape, filters, limit and existing status names. Extend strict result/schema readers to v3; v3 pre-decision pending maps to parent retry_scheduled/retry_released. FALSE still takes precedence as ignored; other completed requires executed, blocked requires not_executed, absent disposition/result remains accepted. Never synthesize success on inconsistent stored data: existing unavailable response and sanitized invariant diagnostic. History shows lookup found/not-found/failure, projected fields with absent vs empty distinction, pinned revision, branch and action status, and explicitly event-level retry metadata. No invented per-node timeline or remote delivery status. Summary-list schemaVersion/workflowVersion unions must add 3 without changing cursor/filter semantics.

A matching processed publication remains valid evidence for `completed` or `blocked` after a retry. An unprocessed publication represents `retry_released` only when the disposition is `retry_scheduled`. The display precedence of `ignored` never bypasses validation of the underlying result, disposition or publication evidence.

### Execution contract validation ownership

The published JSON Schema 2020-12 must accurately describe the versioned wire structure and schema-expressible lifecycle constraints; every valid serialized reader output must validate against it. Schema validity is necessary but not sufficient: fail-closed readers must additionally enforce the documented semantic and persistence invariants. No mathematical equivalence between schema validity and valid reader output is claimed.

| Owner | Normative responsibility |
| --- | --- |
| Published schema | Keys, types, discriminants, schema-expressible lifecycle constraints and failure code categories. |
| v3 parser | Runtime JSON object safety and exact envelope relationships. |
| Reader / pinned validator | Equality of outer, result and receipt event IDs; normalized CEP equality; graph node, target and failure attribution; recomputed condition/input correspondence. |
| SQL / reader evidence | SQL NULL versus JSON null, and disposition/publication correspondence. |
| Worker transaction | Result and disposition lifecycle together. |

Migration owner should allocate **013 onward** after checking concurrent work (none created by this ADR):

1. Add new versioned graph/result/target guard functions and constraints accepting unchanged v1/v2 or strict v3. Replace blocking 009 result/graph checks atomically with new NOT VALID checks; validate separately, as 010/012. Retain or supersede existing type/target checks explicitly; do not merely edit an IMMUTABLE function body used by a validated constraint. Enforce v3 types and result invariants, including null/missing distinctions and allowed projected address keys.
2. Add v3 observation/result update immutability guard. No new columns, event mutation, history rewrite, backfill or data table required. Preserve legacy SQL NULL graph adaptation only for schema1. Verify direct SQL bypass rejection and cleanup deletion behavior.
3. Update migration runner's constraint-presence logic: it currently detects only `automation_graph_valid_v2` and replays older migrations if absent. A new installation and a rerun after superseding constraints must not reinstall v2-only restrictions or fail old validation names. Test fresh, upgrade, repeated run and interrupted validation paths.
4. Update API schema serializers/published automation, execution and summary schemas, strict frontend readers/writers, worker, configuration and fixtures together. Do not allow serializer projection to strip new config or empty fields. All old writers/workers must be fenced before enabling v3; merely bumping schema does not stop an old worker from blocking/acking work.
5. With writes off, migrate, deploy capable readers/workers, verify compatibility and isolated mocked E2E. Then enable both write gates, explicitly create/save/activate a tested revision, and enable acceptance snapshots as applicable. Obtain separate Lead approval for live external evidence and deployment.
6. Roll back by disabling new writes/activation and deactivating heads through a graph-aware path. Retain v3-capable worker/readers/DB until outstanding and blocked snapshots are resolved. Do not drop v3 constraints/results or downgrade executors while work remains. The fixed external read cannot be turned into a successful no-op on rollback.

## Observability and validation contract

Add bounded structured events/counters for lookup attempted, reused, found, not_found, failed, scheduled, exhausted, security rejection and invariant violation; latency and body-byte histograms, event transaction duration, and existing retry/blocked counts. Metric labels are only provider=`viacep`, outcome, allowlisted code/classification and HTTP status class; never CEP, address, path, IDs or scope. Logs may correlate event/execution/automation/revision/node/generation/attempt without values. Record retry scheduling after commit separately from attempted HTTP telemetry so a rolled-back observation is not misrepresented as durable history. No metrics backend or SLO is claimed to exist.

The following matrix is required acceptance evidence. Use deterministic injected transport/DNS/clock seams with no configurable production endpoint. Real PostgreSQL/RabbitMQ integration tests prove persistence/recovery; mock-only tests do not.

| Area | Exact required cases/assertions |
| --- | --- |
| Graph/version | Valid fixed/event v3 round-trip; stable IDs/positions and array permutation; v1/v2 unchanged; reject v2 fifth node, schema mismatch, missing graph, null graph, unknown keys/types, arbitrary URL, 0/2 lookups, cycles, dangling edges, wrong TRUE/FALSE targets, wrong node reference and forward reference. |
| CEP | Accept `01001000`, `01001-000`, `00000000`; normalize to eight digits without losing zero. Reject number 1001000, booleans, null, missing, object/array, 7/9 digits, whitespace/newline suffix, signs, letters, Unicode digits, extra hyphens, embedded path/query. Invalid fixed save writes no revision; invalid event runtime makes zero DNS/HTTP calls and blocks permanent. |
| Response projection | Official example plus each of 14 expected keys individually present/empty/absent; cep required/matching. Preserve accented strings and codes. Reject expected-field null/number/object/array, malformed UTF-8/JSON, scalar/array roots, mismatched/missing cep, overlong strings and unsafe keys. Ignore unknown fields without leakage. Document parsed duplicate-key limitation. |
| Not found / HTTP | Exact boolean erro:true yields not_found permanent, null address, no condition/action and no scheduled retry; reject string marker, false/null and contradictory fields. Test 200, 204, 301/302/307/308, 400, 404, 408, 429, 500/503/599; only 429/5xx transient. No redirect target contacted. |
| Resource/security | 16384 bytes accepted if otherwise valid, 16385 rejected with/without Content-Length; streamed excess aborts promptly. Test DNS/connect/TLS/header/body stalls, resource cancellation, wrong MIME/encoding, header overflow, TLS hostname/chain failure, public/private mixed DNS, loopback, RFC1918, link-local metadata, CGNAT, ULA, multicast, mapped IPv6, rebinding and secondary lookup avoidance; ambient proxies cannot route requests. |
| Conditions | Event vs step isolation, hyphenated node IDs, address.uf TRUE/FALSE, empty vs absent exists/equals/not_equals, all existing operator/type-error cases, prototype/getter protection, object/array terminal values, path bounds. Lookup failure never invokes predicate or falls through to FALSE. |
| Worker/retries | Timeout, DNS temporary failure, reset, 429 and 5xx: one call per unresolved execution per attempt, attempts 1/2 schedule 1000/2000 ms, attempt 3 blocks exhausted, no further schedule. Found lookup plus transient peer reuses original address with zero repeat calls even if fixture changes. For non-found lookups, verify exact own-failure mirroring, only the strictly stronger peer overrides specified above, tie retention, unknown `viacep_unknown` retained under a permanent peer, and own transient canonicalization at exhaustion. Mixed permanent/transient/unknown precedence; mixed v1/v2/v3; all-FALSE baseline; no receipt when aggregate fails. |
| Replay/crash | Same identity/content returns original event/snapshot and no rematch; changed content 409. Concurrent duplicate deliveries serialize. Crash before response, after response/pre-commit, and after commit/pre-ack: pre-commit may requery, committed found result cannot change; terminal redelivery makes zero calls. Test stale/new generation evidence, restart, scheduler/relay crash and unknown commit outcome. |
| Immutability/SQL | Raw SQL malformed v3 graph/result/target/type rejected; null vs missing checks; immutable found observation cannot be changed/cleared, including transition to result NULL; terminal results cannot mutate. Pending disposition updates remain legal. Pinned event/revision/node/input correspondence checked; corrupt prior observation fails closed rather than requery. |
| Migrations/API | Fresh 001→newest, existing NULL/v1/v2 data upgrade byte-equivalent logically, rerun and interrupted validation; no reinstall of incompatible checks. Verify the published schema and fail-closed reader obligations above, including validation of every valid serialized reader output and rejection of semantic or persistence inconsistencies even when schema-valid; v3 summary/detail/history, gate-off reads/deactivation, gate-on save, disabled create/edit/activate, optimistic 409, 413 body and unavailable invariant handling. |
| Configuration/logging | Defaults and all numeric bounds; invalid/empty/signed/leading-zero/noninteger config fails startup; boolean typo rejected. Assert no payload/CEP/URL/body/raw exception in captured logs or tracing; correlation fields and bounded codes present. |
| E2E with controlled provider | Create inactive → save → reload → activate → public POST /events with data.cep → real relay/worker/scheduler → persisted lookup → SP TRUE executed and other UF FALSE ignored → reload history. Restart between acceptance/processing and during retry; change/deactivate head and prove old pinned graph/result. This proves workflow integration, not real provider reachability. |
| External real query | Separately opt-in one public sample CEP (e.g. official 01001000), actual fixed HTTPS transport/security path, record timestamp, revision/event correlation, response classification and persisted branch/action evidence without raw addresses in logs. No mass queries, no CI dependency, no assertion that provider fields never change. A direct curl/browser request alone is not workflow E2E evidence. If outbound DNS/TLS/network is unavailable, report the exact blocked stage and mark live E2E **not verified**, never replace it with a fixture while claiming real execution. |

## Evidence limitation and handoff

This task performed source/documentation inspection only; no real ViaCEP lookup, worker execution, database migration, benchmark or security transport validation was performed. Context7 retrieval of provider documentation is **not** external-real-query evidence. Implementation owners must select and independently review a transport that meets the destination-binding/deadline contract; no unverified library capability is asserted here.

PostgreSQL integration evidence and live ViaCEP workflow evidence remain gaps for this correction; this documentation update does not verify them or approve enablement.

Backend owns schemas/migrations/adapter/worker; frontend owns graph/config/history contract implementation; QA owns the matrix and independently reviewed crash/security evidence. Lead owns approval of v3, outbound access and enablement. Blocking questions for broader use are match-set/lock-duration requirements, privacy/access controls, provider quota handling and independently checkpointed observations. None justifies silently expanding this slice into a broker replacement, exactly-once system, authentication design, MCP integration or RAG retrieval path.
