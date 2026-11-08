# Increments 1–2A.2: local proof only

This is a local-development executable slice, **not production software**, full R1–R6 conformance, or evidence for any of the 176 architecture fixtures. Use disposable local services and synthetic data only. No authentication, tenant isolation, authorization or revocation serialization exists; `scope` is caller-supplied data, not a security boundary. The API listens on loopback only. Do not expose it or connect it to shared infrastructure.

## Run (PowerShell, Node 24)

From `backend/`, use an isolated Compose project and set the disposable URLs as shown in `.env.example` in the shell (the application does not load `.env` automatically):

```powershell
npm ci
docker compose -p intelifluxo-i1-local up -d --wait
$env:DATABASE_URL='postgresql://local:local@127.0.0.1:55432/intelifluxo'
$env:AMQP_URL='amqp://local:local@127.0.0.1:55672'
npm run migrate
npm run api      # separate shell
npm run worker   # separate shell
# Submit an event first, then in another shell with the same environment:
npm run relay
```

Run `npm run scheduler` to release up to 100 due dispositions, then `npm run relay` to publish pending initial and retry outboxes (up to 100 of each). Both commands are bounded sweeps and exit; repeat manually as needed. Run **only one relay** against this database. It first runs the mandatory-return/confirm adapter conformance gate on the connected broker and fails without publishing application messages if the gate fails. Broker connection failure leaves acceptance and outbox independent. A crash between broker confirm and DB update may duplicate a message of the same generation. There is no continuous scheduler, ownership/fencing/reaper, capacity admission, quarantine/repair, lease, business DLQ, or automatic process restart. A worker error closes its channel without ack; it does not restart itself. No external effects or exactly-once delivery are implemented. Publication confirmation is independent of completion. No AI actions or production deployment are included.

Compose uses loopback-published ports, intentionally public disposable demo credentials and nonpersistent database storage. Stopping/removing containers can lose local data. Never use these credentials elsewhere. Shutdown with `docker compose -p intelifluxo-i1-local down` only after confirming the project contains only your disposable resources.

## Contract v1

`POST /events` has `Content-Type: application/json`, maximum body 8192 bytes, and the exact flat request schema in `schemas/event-request-v1.schema.json` (also enforced by `src/contract.ts`). Lengths are JSON Schema Unicode character counts; identifiers contain only ASCII letters, digits, underscores and hyphens, with no trailing line terminators. The message consists of Unicode scalar values excluding U+0000: NUL and unpaired UTF-16 surrogates are rejected with 400 before any transaction. Supplementary characters are supported; the database must use UTF-8 encoding. Example:

```json
{
  "scope": "demo",
  "idempotencyKey": "key-1",
  "type": "receipt.v1",
  "target": "local-receipt",
  "message": "hello"
}
```

New acceptance returns 202 `{"id":"<uuid>","replay":false}` after commit; identical replay returns 200 with the same ID and `replay:true`. The unique identity is `(scope,idempotencyKey)`. Content equality is PostgreSQL JSONB equality of the exact validated `type`, `target`, and `message`; object member order and JSON escape spelling do not matter, Unicode normalization is not applied. Different content returns 409 `{"error":"idempotency_conflict"}`. Unknown fields, invalid values and malformed JSON are rejected with 400; over-limit bodies return 413; unsupported content type returns 415. These validation errors use Fastify's standard error response. Duplicate JSON members and invalid UTF-8 are not explicitly rejected by this proof and must not be relied on; nesting is not accepted by the flat schema but parser behavior is not a hardened security boundary.

`GET /events/:id` returns 200 with `{id,scope,content,createdAt,publication,status,result,retry}` or 404 `{"error":"not_found"}`; malformed IDs return 400. `publication` is `pending` or `confirmed` for the current generation, `status` is `accepted`, `completed`, `retry_scheduled`, `retry_released`, or `blocked`, and `result` is null until the receipt commits, then `{kind:"local-receipt.v1",eventId,message}`. During `retry_released`, `retry.generation` is the newly released generation while `attempt`, `outcome`, delay and due time describe the preceding committed disposition; they update when processing commits. `GET /status` describes the profile and principal limitations. No endpoint provides authorization.

Acceptance inserts event/idempotency binding, fixed target snapshot (`local-receipt`, version 1), acceptance audit and outbox in one transaction. The dispatch is `schemas/dispatch-v1.schema.json`; the worker looks up accepted content by event ID and commits a deterministic receipt unique by event ID before manual ack. The internal unique receipt is not an exactly-once guarantee for external side effects. Rows are treated as immutable by the application, but database roles/triggers do not enforce immutability.

## Tests and observability

`npm run format`, `npm run typecheck`, `npm test` run local checks. To include real services, set both URLs and `$env:INTEGRATION='1'`, then run `npm test` or `npm run test:integration`. The integration suite requires disposable dedicated database and broker services, permission to create and drop a schema, and no other processes using its randomly named resources. Each run creates an isolated schema and uniquely named application queue, and cleans up only those owned resources. An interrupted run can leave its test schema or queue behind; inspect ownership before manual cleanup. Never point it at shared or production infrastructure. Without opt-in, real-service tests are skipped. Tests include explicit return/confirm traces and a commit/ack barrier with actual broker redelivery; they do not implement all QA acceptance case variants or map any 176-fixture IDs. The offline check uses an unreachable endpoint and checks pending rows, not broker stop/restart or recovery.

Logging is intentionally minimal: scheduler and relay emit structured sweep counts, worker reports consumption/error, and connection errors are sanitized. No metrics, tracing, dashboards, alerting, retention, operational repair or security monitoring are provided. The migration runner applies 001 through 004 using idempotent bootstrap SQL; it is not a production migration framework. Image tags are pinned but not digest-locked. No independent critical-change review has been performed by this subagent.

## Increment 2A.1: persisted disposition, not retry execution

The worker records generation 0 and attempt 1 atomically with its disposition.
Legacy v1 dispatches omit generation and mean generation 0. A matching duplicate
is acknowledged without invoking the handler again. Other generations fail closed;
this is not full generation fencing. Existing receipts remain completed after migration.
GET returns `retry` as null before disposition (and for legacy receipts), otherwise
it reports persisted generation, attempt, outcome, delayMs, nextEligibleAt and reason.
A scheduled timestamp is sampled from the database clock. `retry_scheduled` alone does not mean a retry will run: manual scheduler and relay sweeps are required. The internal
handler injection is a test seam, not a request or dispatch feature. The default
policy is three attempts, base 1000 ms, cap 60000 ms. Delays are deterministic
exponential backoff without jitter, unlike the proposed QA full-jitter criteria;
this increment does not satisfy or claim 2A-U02.

## Increment 2A.2: bounded release and publication

The scheduler locks event rows in worker lock order, rechecks due time using PostgreSQL `clock_timestamp()` after the lock, and atomically increments the generation and inserts a unique `(event_id,generation)` retry publication. A pending released generation is not released again. The relay publishes outside the database transaction using the existing mandatory/confirm gate, then marks the row confirmed. Processing commits its disposition and processed marker before ack. Competing schedulers are supported; concurrent relays are not coordinated and may duplicate publications. Under the event lock, an older generation is acknowledged only with durable evidence: publication 1 proves generation 0's scheduled disposition was committed, while a positive generation requires its own processed marker. This relies on application-managed rows and the scheduler's atomic release invariant; direct database edits can violate it. Future generations and older deliveries without evidence fail closed and can stop the worker. No reaper or operator repair mechanism is provided.

For a self-contained real-service demonstration, with the disposable URLs above set, run `npm run demo:retry`. It creates a uniquely named disposable schema and queue, submits synthetic input through the API, uses an internal-only handler seam to produce the first transient outcome, waits for the database deadline, and prints real persisted states and the consumed broker dispatch. It drops its own schema and queue afterwards. An interrupted run may leave those uniquely named resources. No producer payload can select a handler outcome.

## Integrated demo and cleanup

With dedicated disposable local PostgreSQL and RabbitMQ running and the URLs above explicitly set, run:

```powershell
$env:DEMO_LOCAL='1'
npm run demo:integrated
```

The guard requires loopback service URLs without query parameters and explicit opt-in; loopback does not prove the services are disposable. The demo creates a random schema and queue, starts a temporary loopback API on an ephemeral port, and prints and checks each API state through confirmed generation 1, attempt 2 success. Its first transient outcome uses an internal test seam. Scheduler and relay are actual bounded sweeps, not background services. The API URL is available only while the command runs. No other processes should access the demo resources.

Cleanup attempts each channel, connection and owned queue independently, even after failure. The schema and synthetic event are intentionally retained, including on failure, and the printed schema identifies them; an interrupted process may also leave its queue. After inspecting the printed schema and confirming it belongs only to this run, connect to the same disposable database and manually execute the following, replacing the identifier with the exact printed schema (never use a shared schema):

```sql
DROP SCHEMA "demo_replace_with_printed_schema" CASCADE;
```

This permanently deletes all objects and rows in that schema. Inspect broker ownership before manually removing any queue left by interruption. Do not run cleanup against shared or production resources.

# Automation definitions (layer 1)

Definitions are metadata only; event matching and execution are not implemented.
`POST /automations` accepts `{"scope":"demo","name":"Receipt","schemaVersion":1,"trigger":{"type":"receipt.v1"},"action":{"type":"record-receipt.v1"}}` and returns 201 with inactive revision 1. Scope is immutable; name is 1–200 characters and scope 1–128, each requiring a non-whitespace character. Unknown properties are rejected.

`GET /automations?scope=demo` returns `{ "items": [...] }`, ordered by UUID and limited to the first 100 (no pagination); `GET /automations/:id` returns the current revision. IDs use lowercase canonical UUID syntax. `PUT /automations/:id` accepts the full configuration (name, schemaVersion, trigger, action), plus boolean `active` and integer `expectedRevision`; it never accepts scope. Each successful update appends a revision, including activation and deactivation. Concurrent/stale writes return 409 `{"error":"revision_conflict"}`; missing IDs return 404 `{"error":"not_found"}`. Invalid input returns 400. Responses include `id`, `scope`, `revision`, `name`, `active`, `schemaVersion`, `trigger`, `action`, and ISO `createdAt`. There is no authentication or tenant isolation; scope is not an authorization boundary. Migration 004 is additive and only creates definition storage.
