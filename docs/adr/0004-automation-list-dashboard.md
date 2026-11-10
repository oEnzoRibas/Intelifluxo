# ADR 0004: Bounded automation summary listing

- Status: **Accepted**; Stage 1 architecture only, not implementation or deployment approval
- Date: 2026-11-09
- Scope: Read-only automation list dashboard contract
- Predecessor: [ADR 0003](0003-conditions-and-decisions.md)

## Evidence and constraints

Inspection in this worktree found:

- [Definition routes](../../backend/src/automations.ts) require scope for `GET /automations`, join only the current revision, sort by `d.id`, and return at most 100 full definitions without continuation metadata. Creation uses random UUIDs. Updates append an immutable revision and atomically advance the head; scope and ID do not change.
- [Migration 004](../../backend/migrations/004_automation_definitions.sql) already provides the definition UUID primary key, `(scope,id)` index, revision `(automation_id,revision)` primary key, deferred head FK and mutation guards. [006](../../backend/migrations/006_automation_graph.sql) permits legacy SQL NULL graphs; [009](../../backend/migrations/009_automation_conditions.sql) and [010](../../backend/migrations/010_validate_automation_conditions.sql) support validated v1/v2 graphs. The [runner](../../backend/src/migrate.ts) currently applies migrations through 012.
- [API configuration](../../backend/src/api.ts) disables query type coercion and additional-property removal. Its automation validation envelope is `{error:"validation_failed",issues:[{code,path}]}`. `/status` explicitly reports local-development-only with no authentication or tenant isolation.
- The [frontend list parser](../../frontend/src/automation-api.ts) requires exactly `{items}` and full definition fields. Adding page metadata to that response is **not compatible** with this reader. [Unit tests](../../backend/test/automations.test.ts) assert missing scope is rejected on the old route and published schemas match route schemas; [integration tests](../../backend/test/automations.integration.test.ts) assert exact old envelopes and immutable revision behavior.
- [Backend documentation](../../backend/README.md) restricts use to local disposable services and synthetic data. Older [architecture documentation](../architecture/visual-automation-mvp1.md) describes earlier graph/version stages; current code, migrations and ADR 0003 supply the newer version evidence.

There is no established volume, latency SLO, requirement for page-number jumps, alphabetical sorting, total count, snapshot export or multitenant access. The numerical limits below are proposed input safeguards, not measured capacity. Production-quality contract discipline does **not** make the existing platform production-ready.

## Decision and alternatives

Add **`GET /automations/list`**, a static summary route with optional scope, keyset pagination and SQL-side filtering. Keep `GET /automations?scope=...`, detail and write routes unchanged. The dashboard uses the new route even when scoped. The static route must resolve before the UUID parameter route; test this explicitly. This route separation avoids implicit response-shape negotiation and permits a lightweight summary without changing full-definition readers.

| Option | Benefits | Costs / decision |
| --- | --- | --- |
| UUID keyset, ascending | Reuses existing order/indexes; updates cannot move a row; no deep-offset skipping | No arbitrary page jumps; not chronological; selected |
| Offset with UUID order | Simple page numbers | Concurrent membership changes shift offsets; skipped rows still computed; rejected without a page-jump requirement |
| Name, active or revision timestamp sort | More presentation-oriented | Mutable sort keys move between pages; composite cursor/index complexity; deferred |
| Change old envelope or infer mode from query keys | One route name | Breaks strict existing readers or introduces conditional DTOs; rejected |
| Materialized snapshot / server-held cursor | Repeatable whole traversal | Session/retention/cleanup costs not justified for a live dashboard; deferred |

PostgreSQL documentation confirms the need for a unique [LIMIT ordering and the cost of OFFSET](https://www.postgresql.org/docs/current/queries-limit.html). No new database, broker, event flow, read-model service, cache, MCP or RAG capability is needed.

## Request contract

`GET /automations/list` accepts only the following optional, single-valued query parameters. Reject unknown keys and duplicate occurrences, including duplicates with identical values. URL decoding happens once via the HTTP query parser; values below refer to decoded strings. Validate before database access; do not enable global coercion.

| Parameter | Accepted values / default |
| --- | --- |
| `scope` | Exact case-sensitive equality; existing scope rules: 1..128 Unicode scalar values, at least one non-whitespace character, no NUL/unpaired surrogate. Preserve whitespace; no trimming/normalization. Omitted means all scopes. |
| `q` | Literal case-insensitive substring of current name **or** scope. 1..200 Unicode scalar values, at least one non-whitespace character, no NUL/unpaired surrogate. Preserve whitespace; omitted means no search. Empty/whitespace-only input is 400, not an unbounded search. |
| `active` | String `true` or `false` exactly; omitted means both. Reject `all`, `1`, empty, case variants. Convert explicitly to a SQL boolean after validation. |
| `limit` | Decimal string matching `^(?:[1-9][0-9]?|100)$`; default 25. Thus 1..100, no signs, whitespace, leading zeros, exponent or fraction. Convert only after validation. |
| `cursor` | Canonical lowercase UUID, same syntax as existing definition IDs, exactly 36 characters. Omitted means first page. Empty is invalid. |

All supplied predicates combine with AND; only the name/scope search branches combine with OR. Search treats `%`, `_` and backslash as literal characters, not user-provided pattern syntax. Case folding follows the database's configured locale for `ILIKE`; no accent folding, Unicode normalization, fuzzy search or cross-locale equivalence is promised. Include ASCII case-folding tests and document the test database locale for non-ASCII cases.

The cursor is deliberately a **transparent position token**, not a secret, authorization token or opaque snapshot handle. Its value is the last returned definition UUID, never the lookahead UUID. It need not reference an existing row. Clients repeat their original filters and may change limit; changing any filter starts a new traversal without a cursor. The server does not bind a cursor to filters: a syntactically valid UUID with changed filters is accepted as a lower-bound query, not rejected as a mismatch. No signing, expiry, cursor storage or count query is required. Future ordering changes require a new contract rather than silently reinterpreting this token.

Examples:

```text
GET /automations/list
GET /automations/list?q=receipt&active=true&limit=25
GET /automations/list?scope=demo&limit=25&cursor=00000000-0000-0000-0000-000000000019
```

## Exact success response

HTTP 200, JSON with exactly these top-level keys, including explicit null when terminal:

```json
{
  "items": [
    {
      "id": "00000000-0000-0000-0000-000000000019",
      "name": "Receipt",
      "scope": "demo",
      "active": true,
      "revision": 3,
      "schemaVersion": 1,
      "workflowVersion": 1
    }
  ],
  "nextCursor": null
}
```

Every item has exactly the seven illustrated required keys. `id` is a canonical lowercase UUID; name/scope retain the existing text contracts; active is a JSON boolean; revision is an integer 1..2147483647 identifying the **current** revision visible to this read. `schemaVersion` is integer 1 or 2. `workflowVersion` is integer 1 or 2 from the effective graph version: SQL NULL legacy graph means v1, as on the existing detail route. Supported current writes pair graph/schema versions, but expose their distinct meanings rather than inventing an independent workflow revision counter. No graph nodes, trigger/action, timestamp, execution status or historical revision data is included.

`items.length` is 0..limit. `nextCursor` is a UUID only if the SQL query observed a matching lookahead row; otherwise null. Empty results, unknown scope, or a valid cursor beyond the end return exactly `{"items":[],"nextCursor":null}`. There is **no total, estimated total, totalPages or hasPrevious**. Do not derive totals from page length or the legacy 100-row cap. Fetch detail before editing; a summary is not sufficient input for a full replacement PUT.

Publish a separate summary-list schema (suggested `automation-list-v1.schema.json`) and shared contract fixtures in the backend implementation; do not change the meaning of the old schema's `query` or `response` definitions. `v1` here versions the list transport contract, not the workflow/schema version.

## Errors and failure behavior

- Invalid query: HTTP 400, exactly `{"error":"validation_failed","issues":[{"code":"invalid_shape","path":"/limit"}]}` for a lone invalid limit. For any invalid parameter use its JSON Pointer path; escape unknown key names as JSON Pointer segments. Deduplicate issues by path and sort lexically by path. Root-shape errors use `/`. Each issue has exactly `code,path`, with code `invalid_shape`. No rejected values or SQL details in the response. Duplicate keys use the duplicated parameter path.
- Database/connectivity/query failure: HTTP 503, exactly `{"error":"unavailable"}`; no partial page or synthetic empty success. A malformed stored summary/version invariant also fails the whole page with 503 and a sanitized server-side invariant diagnostic. Do not silently omit corrupt rows. These are explicit new-route behaviors; they do not change old-route exception handling.
- No 404 for an empty list or missing cursor row; no revision conflict response on reads. Infrastructure/parser failures before route validation retain the existing HTTP server behavior; the parameter envelope is not a promise to normalize malformed HTTP or oversized request-target errors.
- GET is safe to retry but the page may change. No internal retry loop or background work is introduced. The dashboard must distinguish failed requests from successful empty results and discard stale responses after filter changes.

## SQL and resource bounds

Execute one parameterized SELECT against current heads per page. SQL performs all predicates, ordering and limiting before rows reach application memory. This reference shows the query shape with all optional predicates supplied (omit absent clauses and their parameters in the implementation, using only fixed server-owned SQL fragments):

```sql
SELECT d.id, d.scope, r.name, r.active, r.revision, r.schema_version,
       CASE WHEN r.graph IS NULL THEN 1
            ELSE (r.graph->>'version')::integer END AS workflow_version
FROM automation_definitions d
JOIN automation_definition_revisions r
  ON r.automation_id = d.id AND r.revision = d.current_revision
WHERE d.id > $1::uuid
  AND d.scope = $2::text
  AND r.active = $3::boolean
  AND (r.name ILIKE $4::text ESCAPE '!'
       OR d.scope ILIKE $4::text ESCAPE '!')
ORDER BY d.id ASC
LIMIT $5::integer;
```

For search, construct `$4` by replacing each literal `!` with `!!`, `%` with `!%`, `_` with `!_`, then surrounding the escaped string with `%`. Backslash remains literal because the explicit escape character is `!`. Bind the resulting string; never interpolate user text into SQL. `$5 = limit + 1`, at most 101. Return the first limit rows, using the extra row solely to determine continuation. Validate projected supported versions; do not fetch full graphs into the application just to obtain their versions.

Only definition ID participates in ordering/cursor comparison; it is unique, immutable and already indexed. Join the head before filtering: an old active revision must not make a currently inactive definition eligible. Do not fetch all revisions/definitions, issue a query per item, sort/filter in JavaScript, or run COUNT to support this contract.

**No migration is required for this design.** Reuse:

- `automation_definitions_pkey (id)` for unscoped traversal;
- `automation_definitions_scope_id_idx (scope,id)` for exact scoped traversal;
- `automation_definition_revisions_pkey (automation_id,revision)` for head lookup.

No B-tree is claimed to accelerate arbitrary leading-wildcard substring search. Sparse active/search matches can scan many candidate heads; LIMIT bounds transferred rows and application memory, **not database work or latency**. Do not add a boolean-only index across all historical revisions or a trigram extension speculatively. Capture `EXPLAIN (ANALYZE, BUFFERS)` on representative local synthetic data for unfiltered, scope, active, search and combined predicates, first and deep pages. If measured workloads demand more, separately evaluate trigram indexes or a transactionally maintained current-head projection with Lead approval. Any such migration must be additive with independently assessed lock/write/storage costs; no historical revision rewrites.

## Concurrent revision and insertion semantics

Each single SELECT observes one PostgreSQL Read Committed statement snapshot, not a cross-request snapshot. The head and joined immutable revision come from that same statement: a concurrent save can yield the complete old or complete new revision, never a mixture of name/active/version fields from different revisions. No definition locks or long-lived repeatable-read transaction are needed for a dashboard.

- With fixed filters and unchanged membership, walking returned cursors yields each matching ID exactly once in ascending order.
- Updating a returned ID cannot cause it to recur on subsequent forward pages, because its ID is unchanged and the lower bound is strict.
- Changing name/active on an unseen ID may make it enter or leave the remaining result set. An ID at or below the cursor that newly matches is not revisited. Later pages show current values at their own statement snapshots, not values pinned on page one.
- New random UUIDs can land before or after the cursor: earlier IDs are missed by this traversal; later matching IDs can appear. This is not creation-time order or a complete snapshot export.
- `nextCursor != null` reports lookahead at the current statement, not a guarantee the next page will be nonempty after concurrent changes. Similarly null is not a promise that future writes cannot add results.
- Reusing a prior cursor to navigate back refetches a live page; it cannot promise identical content. Restart without a cursor to refresh the full list. Saving from subsequently fetched detail retains existing `expectedRevision` conflict protection; the list does not pin edits or executions.

## Access, observability and rollout

All definitions remain accessible without identity checks, exactly as with existing caller-chosen scopes and ID reads. The new unscoped route makes discovery easier; it does **not** add auth, infer a tenant from scope, or establish a security boundary. Retain loopback/local-only deployment, synthetic data and the visible local/non-multitenant limitation. Shared/public exposure remains prohibited pending a separate reviewed authentication/authorization/tenant-isolation design. Do not introduce mock user or tenant headers.

Minimum diagnostic contract for the new handler: sanitized failure logs with request correlation, route, failure category; timing and returned-row count where the existing logging facilities permit. Never log raw q/scope, full URLs with queries, graph contents, database credentials or cursors as metric labels. Suggested future low-cardinality metrics are request duration, returned row count and validation/unavailable counts by route/outcome, not tenant/automation IDs. No metrics system or SLO is claimed to exist.

After Lead approval, backend/frontend/QA owners agree exact fixtures and the test matrix below. Implement backend route and published schema first, then the dashboard reader. Keep old clients and old scope route working, including their missing-scope 400 behavior. **Unscoped listing is provided by `/automations/list`, not a silent semantic change to `/automations`.** Do not fall back to the capped legacy route and claim complete pagination. No event, worker, scheduler, broker or conditions gate change is required; reading v2 summaries must work even with v2 writes disabled. UI rollback leaves the additive read route harmless; backend rollback requires disabling the new dashboard first. No deployment is authorized by this ADR.

## Validation matrix (required evidence, not tests run here)

| Area | Required assertions |
| --- | --- |
| Routing and compatibility | Static `/automations/list` succeeds without scope, not UUID-validation 400; old scoped route keeps exact full-definition `{items}` envelope/order/100 cap; old missing-scope request stays 400; detail/write routes unchanged; old strict reader still parses. |
| Summary DTO | Exact seven keys and top-level keys; inactive/active, revisions >1, v1/v2, SQL NULL legacy graph; no graph/config leakage; v2 reads with writes disabled. |
| Query validation | Defaults; limit 1/100 accepted; 0/101/negative/decimal/exponent/leading zero/empty rejected; valid/invalid UUIDs; bounds and unsafe text; each duplicate key, unknown keys, active case variants; 400 issue sorting and zero storage calls. |
| Search/filter | Name OR scope, case folding, literal `%`, `_`, `!`, backslash and quotes; exact case-sensitive scope; all filters ANDed; currently inactive with historical active revision excluded; no SQL injection. |
| Pagination | Seed >200 IDs in deliberately shuffled insertion order; limit 1/25/100; concatenate forward pages equals sorted expected IDs without duplicates; exactly limit and limit+1 matches; cursor equals last returned, not lookahead; final/empty/nonexistent-position cursor; no total fields. |
| Revision concurrency | Controlled barriers around committed updates: page contains coherent old or new head; returned ID update cannot recur; unseen ID activating/deactivating/renaming enters/leaves according to snapshot; behind-cursor newly matching ID is not revisited. |
| Insert/concurrency | Insert before/after lower bound; only later eligible ID can appear; remove remaining eligibility after lookahead and allow empty next page; repeat cursor may observe changed revision. No snapshot-completeness assertion. |
| Resource/query behavior | Exactly one bounded SELECT per page, <=101 returned DB rows, SQL predicates/order/limit, no COUNT/OFFSET/N+1/full-record application scan. Inspect real query plans for first/deep/scoped/sparse/search pages; record data size/distribution/locale and timings without fabricating an SLO. |
| Failures | Inject DB rejection and invalid persisted projected version: 503 exact unavailable envelope, no partial/empty success, sanitized diagnostic; retry can succeed; invalid query never hits DB. |
| Contract distribution | Published summary schema equals handler constraints/serialization; backend and dashboard golden fixtures agree; old generated automation schema remains compatible. |
| Boundary | No auth/tenant invention, no new network binding, no changes to write/acceptance or pinned execution semantics; documentation explicitly says local-only and non-multitenant. |

Stage 1 validation is limited to source inspection and documentation sanity. No integration tests, database plans, load measurements or production guarantees have been obtained by this architecture task. Lead approval of the new route and independent implementation review remain required. If product requires one URL, numbered pages, different sorting, totals or snapshot traversal, revisit this ADR rather than guessing those requirements during implementation.
