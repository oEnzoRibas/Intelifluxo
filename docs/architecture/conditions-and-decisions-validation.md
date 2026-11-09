# Conditions and Decisions: examples and validation contract

Companion to [Lead-accepted ADR 0003](../adr/0003-conditions-and-decisions.md). This is an implementation acceptance specification, not evidence that runtime support exists.

## Golden graph candidate

Embed this graph in an otherwise unchanged definition request with `schemaVersion:2`. On POST use scope/name/trigger/action, no active; on PUT use expectedRevision/name/active/trigger/action, no scope. Fixed trigger/action types remain `receipt.v1` / `record-receipt.v1`.

```json
{
  "version": 2,
  "nodes": [
    { "id": "trigger", "kind": "trigger", "type": "receipt.v1", "position": { "x": 0, "y": 0 } },
    { "id": "condition", "kind": "condition", "type": "condition.v1", "position": { "x": 160, "y": 0 }, "config": { "fieldPath": "message", "operator": "contains", "expectedType": "string", "expectedValue": "approved" } },
    { "id": "action", "kind": "action", "type": "record-receipt.v1", "position": { "x": 320, "y": 0 } },
    { "id": "end", "kind": "end", "type": "end.v1", "position": { "x": 480, "y": 0 } }
  ],
  "edges": [
    { "source": "trigger", "target": "condition" },
    { "source": "condition", "sourcePort": "TRUE", "target": "action" },
    { "source": "condition", "sourcePort": "FALSE", "target": "end" },
    { "source": "action", "target": "end" }
  ]
}
```

Public event requests (each must use a distinct idempotency key) can use `message:"approved"` for TRUE and `message:"pending"` for FALSE. Both use type `receipt.v1`, target `local-receipt`, and the activated definition's scope. Message `"Approved"` is FALSE. Both events still get a baseline receipt; only TRUE reports the automation action executed.

## Public HTTP typed-condition cases

After implementing the accepted extension, enable snapshots and activate the four-node graph with the config in each row below, using a fresh isolated scope per row. POST each full request to `/events` with `Content-Type: application/json`; expect 202, then GET `/events/:id` to verify preserved content and query `/executions?eventId=...`. TRUE must become completed/executed, FALSE ignored, while both retain a completed baseline receipt. These are required integration cases, **not executed HTTP results**.

Full numeric TRUE request (FALSE request changes key to `numeric-false-1` and valor to 100):

```json
{
  "scope": "numeric_case",
  "idempotencyKey": "numeric-true-1",
  "type": "receipt.v1",
  "target": "local-receipt",
  "message": "Condition test",
  "data": { "valor": 150 }
}
```

For each following row use the same complete request envelope, replacing scope with the listed scope, data with the exact object literal, and idempotencyKey with `<scope>-true` or `<scope>-false`. Each row's config is the complete condition config, not an expression to evaluate.

| Scope | Condition config | TRUE request data | FALSE request data |
| --- | --- | --- | --- |
| numeric_case | `{"fieldPath":"data.valor","operator":"greater_than","expectedType":"number","expectedValue":100}` | `{"valor":150}` | `{"valor":100}` |
| string_case | `{"fieldPath":"data.status","operator":"contains","expectedType":"string","expectedValue":"approved"}` | `{"status":"approved today"}` | `{"status":"Approved today"}` |
| boolean_case | `{"fieldPath":"data.cliente.ativo","operator":"equals","expectedType":"boolean","expectedValue":true}` | `{"cliente":{"ativo":true}}` | `{"cliente":{"ativo":false}}` |
| null_case | `{"fieldPath":"data.observacao","operator":"equals","expectedType":"null","expectedValue":null}` | `{"observacao":null}` | `{"observacao":"present"}` |
| exists_case | `{"fieldPath":"data.observacao","operator":"exists"}` | `{"observacao":null}` | `{}` |

Also run numeric_case with `{"valor":"150"}`: HTTP acceptance succeeds, then execution blocks permanently with condition_type_mismatch, not FALSE. `{"valor":[]}` is ingestible but yields invalid_condition_value. `{"valor":150,"unused":[1,null,{"ok":true}]}` still yields TRUE. Omitted data yields FALSE for all listed predicates, including equals-null; root `data:null` is rejected at HTTP acceptance. A scalar/null intermediate (for example `{"cliente":null}`) yields MISSING for `data.cliente.ativo`. These distinguish public validation from asynchronous predicate failure.

## Evaluator vectors

The resolved values below supplement the public HTTP cases with internal evaluator fixtures, including non-JSON values that public acceptance rejects. Public typed values go only under data, never arbitrary top-level properties. MISSING is a test sentinel, not a JSON string/null. For comparison operators expectedType matches the expected JSON literal; exists omits both expected fields.

| Value | Operator | Expected | Verdict |
| --- | --- | --- | --- |
| `"approved"` | equals | `"approved"` | TRUE |
| `"Approved"` | equals | `"approved"` | FALSE |
| `"a b"` | contains | `" "` | TRUE |
| `""` | contains | `""` | TRUE |
| `2` | greater_than | `1` | TRUE |
| `2` | less_than | `2` | FALSE |
| `-0` | equals | `0` | TRUE |
| `false` | equals | `false` | TRUE |
| `false` | not_equals | `true` | TRUE |
| `"2"` | equals | `2` | permanent condition_type_mismatch |
| `true` | contains | `"true"` | permanent condition_type_mismatch |
| null | equals | null | TRUE |
| null | not_equals | `"x"` | TRUE |
| `"x"` | equals | null | FALSE |
| null | exists | omitted | TRUE |
| null | greater_than | `0` | permanent condition_type_mismatch |
| MISSING | exists | omitted | FALSE |
| MISSING | equals | null | FALSE |
| MISSING | not_equals | `"x"` | FALSE |
| MISSING | contains | `""` | FALSE |
| `[]` | exists | omitted | permanent invalid_condition_value |
| `{}` | equals | null | permanent invalid_condition_value |
| nonfinite number | exists | omitted | permanent invalid_condition_value |

Lookup fixtures: `{ "customer": { "active": false } }` with `customer.active` resolves false; absent `customer` or `customer:null` resolves MISSING; `customer:[]` produces invalid_condition_value. Inherited `message` must resolve MISSING; reject accessors without invoking them. Forbidden path examples: `__proto__.x`, `customer.constructor`, `prototype`, `customer[0]`, `.message`, `message.`, `a..b`, `a.*`, `a b`. Normal own field `constructorName` is not a forbidden segment. Exercise exact boundaries for segment count/length, full path, strings, positions and request bytes.

## Required automated matrix

| Area | Measurable acceptance |
| --- | --- |
| Public typed data | Run every HTTP TRUE/FALSE pair above through acceptance, snapshot, worker and history; verify numeric/string/boolean/null/nested data round-trip without coercion and missing differs from null |
| Ingress shape/security | Reject data scalar/null/array root, unknown envelope keys, forbidden/dotted/empty/overlong object keys at all depths (including inside arrays), NUL/unpaired-surrogate/overlong strings, malformed/nonfinite/overflow numbers; persist no records on rejection |
| Ingress bounds | Compact UTF-8 data exactly 4096 bytes accepted and 4097 rejected 400 when total body remains <=8192; total wire body 8192 accepted and 8193 rejected 413 using whitespace padding; distinguish escaped/multibyte raw sizes from compact sizes; root container depth 1 through 7 accepted, depth 8 rejected including empty objects/arrays |
| Path bounds | Accept 8 segments/64 per segment/256 total at each independent valid boundary; reject 9 segments/65-character segment/257 total; forbid array indices and dangerous segments; final arrays/objects fail even for exists, unrelated arrays do not |
| Data equality | Same-key reordered objects/whitespace/equivalent numeric spelling replay 200 with same ID; changed type/nested value/array order, absent versus empty data, missing versus null conflict 409; no rematch or extra outbox/execution |
| Duplicate keys | Characterize actual parser last-member behavior or stricter rejection with raw duplicate-key requests; do not assert duplicate detection; equality uses only accepted parsed content; visible forbidden keys always rejected |
| Event immutability | Attempt direct updates to event identity/content/data after acceptance: rejected; retry/restart uses originally stored data and pinned revision; legacy cleanup deletes still work; GET exposes supplied data but never synthesizes it |
| Graph/config | All allowed vectors accepted; every forbidden type/operator/config key/port/topology rejected; permuting node/edge arrays changes neither verdict nor branch; unknown versions never downgrade |
| Save/activation | v2 full request round-trips IDs/positions/config/ports; v1 placeholder still cannot activate; stale competing PUT yields exactly one success and one 409; rejected requests add zero revisions |
| DB defense | Direct inserts cannot pair schema1 with graph2 or activate placeholders; missing/JSON-null config and incompatible expected values fail; old SQL NULL/schema1 remains valid; migration validation leaves old revisions/results identical |
| Snapshot | Accept at revision N, edit/deactivate at N+1 before worker and retry: execution uses N; duplicate accept never rematches; concurrent acceptance selection is coherent |
| TRUE | Executed result and internal receipt/disposition commit together; branch points to action; history status completed |
| FALSE | Ignored result with no automation receipt payload, branch points to end, no retry caused by FALSE; event baseline still completes; history status ignored |
| Permanent | Tampered/internal invalid config or incompatible runtime value produces blocked/permanent, no action effects, no retry publication; save-time invalid config is rejected earlier |
| Transient | TRUE pending plus retry_scheduled/released; later success executed; exhaustion not_executed/exhausted; FALSE peers remain ignored and expose parent retry separately |
| Mixed matches | TRUE/FALSE/v1 all share event transaction; one failure rolls back all action effects, no TRUE executed result survives; aggregate permanent beats unknown beats transient; FALSE alone never blocks |
| Idempotency/crash | Concurrent deliveries yield one receipt; pre-commit crash leaves no committed decision/effect; post-commit/pre-ack crash does not mutate final results; stale/duplicate generations do not reevaluate effects |
| Recovery | Restart worker/scheduler/relay with scheduled work; pinned condition unchanged; gate-off does not stop execution of pinned v2; infrastructure rollback remains unacked, not false |
| API/frontend | Strict v1/v2 fixtures, unknown read-only records, preserved schema on toggle, port-aware edge identity, manual data.* paths, typed expected fields, exists omission, optional JSON entry blank versus empty object versus null, end visibility, ignored vs blocked, conflict/race/ambiguous-write and real reload |
| Compatibility | Snapshot gate off and zero matches preserve baseline behavior; legacy absent-data request/content/receipt fixtures unchanged without backfill; data-aware request/GET schemas deployed before producers; no fallback stripping data; old-worker fencing demonstrated before v2 activation; rollback retains data-aware API/readers and v2 handlers |

QA should attach actual commands/results and failure-injection evidence per slice. Architecture review only checks consistency of this specification; it is not a substitute for integration tests against the database and broker.
