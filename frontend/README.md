# Operational Overview (local proof)

Frontend for the backend's local-development proof. It can create inactive automation definitions and activate or deactivate them; these actions write to the backend. It is not a production operator console. The backend has no authentication, authorization or tenant isolation, and scope is not an authorization boundary; use synthetic data and loopback only. The profile response is not a dependency health check. Event lookup is a point-in-time snapshot, not a live subscription; publication and completion are independent. The UI does not create or mutate events and does not provide an event list, aggregate metrics, AI actions or fabricated values.

## Run and configuration

Node 24: `npm ci`, then `npm run dev`. Vite proxies `/api` to `http://127.0.0.1:3000` locally. Start the backend separately according to its README. `VITE_API_BASE_URL` optionally sets the browser-visible base URL at build/dev time (e.g. `/api`); no secrets may be placed in Vite variables. An alternative origin requires its own CORS configuration; this backend does not provide it. A deployed static build needs a same-origin reverse proxy for `/api` or an explicitly configured accessible API. Never expose this local proof to shared networks.

Checks: `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## Dependencies and design deviations

`GET /status` supplies profile and limitations; `GET /events/:id` supplies individual event details. The API has no list or aggregate endpoints; those areas intentionally show unavailable. Client response validation rejects unsupported shapes. Requests omit credentials. Status and event responses are not automatically refreshed; retry status or submit the lookup again. Errors do not distinguish CORS, network, HTTP, or malformed responses to avoid exposing internal details.

The official OpenPencil source is `design/openpencil/intelifluxo.fig`. The referenced independent audit and reviewed specifications were not available in this workspace and the OpenPencil MCP was disconnected. Consequently desktop frame 0:335, foundations 0:107, state set 0:659, responsive guidance 0:725/0:774, and keyboard/review criteria 0:931/0:951/0:967 could not be inspected. Exact layout, color, typography, icons, copy, spacing, interaction, breakpoints, and state parity are unverified. This is a provisional functional shell, not an assertion of design compliance; any design-specific components beyond this shell are blocked pending the audit or access to the source. No OpenPencil edits were made.

## Event Explorer

Navigate using Overview and Event Explorer, or open `#explorer` directly. Explorer uses the same labeled ID lookup and in-memory current result as Overview; navigating between views retains a resolved snapshot until the page is reloaded. Leaving Explorer cancels a pending lookup; clearing the input cancels a pending lookup and clears the result. There is no lookup history, server-side discovery, search, filtering, pagination, aggregate or subscription API. Results are point-in-time snapshots; submit again to refresh. UUIDs must use the lowercase format returned by event acceptance. The frontend does not call `POST /events`; IDs must be obtained separately. `GET /events/:id` returns `id`, `scope`, `content`, `createdAt`, `publication`, `status`, `result`, and `retry`. Supported statuses are `accepted`, `completed`, `retry_scheduled`, `retry_released`, and `blocked`; retry contains `generation`, `attempt`, `outcome`, `delayMs`, `nextEligibleAt`, and `reason`, or is null. A `retry_scheduled` schedule is persisted; local execution requires scheduler and relay sweeps in this MVP. `retry_released` means the scheduler released the next generation, whose publication can be pending or confirmed; processing has not completed. Its retry generation is the released generation, while the remaining retry fields describe the preceding committed disposition. The API returns 404 when an ID is not found; other HTTP/network failures and malformed responses show a generic error. Strict runtime validation rejects unexpected event fields or values. This frontend has no credentials and omits cookies from requests.

Explorer frame `0:398` has not been independently inspected in the live design tool. The ID-only workspace replaces any list/discovery representation because the current API has no list contract. Layout, icons, spacing, responsive details and visual parity with that frame remain unverified. Existing Overview behavior is retained; its navigation now includes Explorer. No claim of design approval is made.

## Automation management handoff and limitations

Automation management uses the existing application shell and CSS. The API requires an explicit scope for listing and creation. The selected scope is retained while navigating within Automations, but is lost when leaving that section or reloading the page. The API returns at most 100 entries without pagination; lists say so. Definition revision history and execution updated timestamps are not available, so the UI does not fabricate them; history shows creation timestamps instead. Event links prefill the existing Event Explorer, where the operator explicitly requests the snapshot. The cross-screen prototype and visual fidelity have not been validated in a browser against the design.

Mutation requests can have an uncertain outcome if the connection is lost or navigation aborts the request; inspect the list or reload the definition before retrying. No automatic retries are made for writes.

Dependency audit after upgrading Vitest from 4.0.14 to 4.1.12: `npm audit` reported 9 vulnerabilities (1 low, 7 moderate, 1 high, 0 critical); before the upgrade `npm ci` reported 11 (1 low, 8 moderate, 1 high, 1 critical). Remaining findings include Vite development-server advisories and the TypeScript ESLint/minimatch dependency chain. No automatic audit fix was applied.

### Handoff notes

The existing application color tokens are retained. The automation handoff's apparent theme difference needs design confirmation before any product-wide theme change. Execution-history links prefill Event Explorer; operators explicitly select Look up event to retrieve the snapshot.
