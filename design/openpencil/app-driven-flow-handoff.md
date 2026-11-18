# App-driven local experience - review handoff

## Rescue first-slice handoff — 2026-11-14 (current)

**Ready for Lead review and frontend handoff; not a claim of implementation approval or browser validation.** This section supersedes conflicting older Overview/layout guidance below. Lead explicitly accepted native editable OpenPencil screens plus documented interactions; screen-navigation prototyping is not required. Only the `.fig` and this handoff were edited by this design execution. Existing pages through 20 were preserved. No code, backend, other documentation, Figma, commits or delegation.

### Native index

File: `design/openpencil/intelifluxo.fig`; document `tab-1`. IDs below use prefix `2081966713`; names are stable lookup keys if IDs remap on reopen.

| Page / ID | Frame name | Frame ID | Dimensions |
|---|---|---|---|
| 21 — Rescue / Overview & Automations / `:5` | R21-01 / Overview / Bound desktop | `:9` | 1440×1000 |
| same | R21-02 / Overview / Confirmed zero | `:56` | 1440×1000 |
| same | R21-03 / Overview / Loading | `:95` | 1440×1000 |
| same | R21-04 / Overview / Error | `:125` | 1440×1000 |
| same | R21-05 / Automations / List | `:148` | 1440×1000 |
| same | R21-06 / Automations / Create | `:183` | 1440×1000 |
| same | R21-07 / Overview / Mobile 320 | `:218` | 320×1160 |
| same | R21-08 / Automations / Mobile 320 | `:681` | 320×1100 |
| same | R21-09 / Create / Mobile 320 | `:700` | 320×1100 |
| same | R21-10 / Navigation / Mobile 320 | `:718` | 320×1100 |
| 22 — Rescue / Condition Builder v2 / `:6` | R22-01 / v2 Builder / Selected condition | `:244` | 1440×1232 |
| same | R22-02 / v2 Builder / Saved active and test ready | `:298` | 1440×1232 |
| same | R22-03 / v2 Builder / Validation and conflict | `:345` | 1440×1232 |
| same | R22-04 / Execution / Truthful result panel | `:400` | 1440×1232 |
| same | R22-05 / v2 Builder / Mobile 320 | `:440` | 320×1640 |
| same | R22-06 / Guided flow / Choose before editing | `:902` | 1440×900 |
| 24 — Rescue / Components & State handoff / `:8` | Rescue / Operational state (24 native variants) | `:875` | variants 432×224 |
| same | R24-01 / Tokens and handoff | `:859` | 960×1000 |

Result-panel mobile adaptation: R22-05's single-column shell followed by the result cards of R22-04 in document order, each width 288 and auto-height. Retain all publication, decision, action and retry information; never shrink the desktop graph to fit.

### Visual foundations and responsive rules

Industrial Dark continues existing variable names, not a replacement palette: `color/canvas` #10151C; `builder/well` #0B1016; `builder/panel` #151E28; `builder/raised` #202D3A; `color/text` #E5EDF6; `color/muted` #B9C8D8; `color/action-soft` #B6D3FF; `color/success` #73C7A1; `color/warning` #E9BA69; `color/error` #ED8790; control boundary `builder/control-border` #657B91. Text/background fills in new frames use existing native variables.

Inter Regular: helper 14, body 16, section 22–24, heading 28–32. Spacing 8/16/24/32; radius 8; controls minimum 48 high, touch targets at least 44×44. Focus is a 2px action-soft ring with 2px separation; selection uses a persistent border plus selected text, not focus alone. TRUE/FALSE always have words and destinations, not color alone.

Desktop shell: sidebar 216; main margin 32. Builder is a dedicated **full-width** task surface with no sidebar: 24px outer margins, canvas 952, gap 24, inspector 416 at 1440px. Result panel spans content width beneath editor. At 768–1199 use compact Menu, wrap toolbar, stack inspector below graph whenever both cannot fit without squeezing controls. Below 768: one column, 16px margins; at 320 content is 288. Native mobile node studies are 272 wide centered within content. All text/controls auto-height when wrapping; no essential truncation or horizontal page scrolling. Cards, forms, toolbar and results retain their information when stacked. Sidebar becomes an in-flow navigation disclosure, not a modal. At 200% text, grow everything vertically; no fixed-height clipping. Canvas coordinates are design studies, not implementation positioning requirements.

### Real contract bindings (no fabricated telemetry)

Evidence inspected read-only: `backend/src/overview.ts`, `frontend/src/automation-api.ts`, `condition-contract.ts` and existing native variables/components. No research participants or runtime responses were supplied. Design markers such as “Nome retornado”, “—” and explanatory binding text are annotations, **not production data or shipping empty-state copy**.

| Surface | Binding / constraint |
|---|---|
| Overview | `GET /overview?period=24h|7d|30d`, default 24h. Current worktree now has aggregates; older `/status`-only guidance below is obsolete. |
| Active automations / execution cards | `automations.active` / `executions.total`. Never derive counts from recent rows. `automations.total` may appear as secondary total if needed; not an invented metric. |
| Success rate | `executions.successRate` ratio as percent; denominator is success + failed. Null shows “— / Sem resultados elegíveis”, never 0%. Skipped and pending/unknown are not failures or eligible denominator entries. |
| Activity | `buckets[].start/end/executions`; rolling UTC window, execution **creation** time. Draw bars only from returned buckets; provide the same counts as an accessible interval/count table. No sample heights. |
| Recent / attention | `recent[]`, `problems[]`: name, returned status, createdAt and internal execution/automation IDs. At most 10; problems include event-scoped state, not a global incident count. State scope must remain explicit. |
| Unsupported metric | Completion duration/latency unavailable: `limitations.completionTime`; no completion timestamp exists. No latency, duration, trend, health or zero-problem claims. |
| List | `GET /automations/list` via existing adapter: `q`, `active`, opaque `cursor`; items contain name/scope/active/revision. `nextCursor` alone controls Carregar mais; no fake totals. |
| Create / detail | Existing `POST /automations` with scope/name creates **disabled v1**. Open returned definition by internal ID; then choose guided v2 locally. Existing `PUT /automations/:id` uses expectedRevision, graph and schemaVersion 2. Do not invent v2 POST or a remote draft. |
| Condition | Four nodes/four edges: Trigger→Condition; TRUE→Action→End; FALSE→End. Existing fieldPath/operator/expectedType/expectedValue. “Mensagem” maps to `message`; “Contém” to `contains`, type string. Custom event field paths use existing validation, not UUIDs. |
| Execution | Existing execution endpoints/adapter: status, result.decision, result.action, receipt, failure and event-scoped retry. Only actual response evidence establishes the outcome. createdAt is not completion time. Limited execution lists do not prove complete peer coverage. |

### Exact interactions, focus and states

Existing route `#overview` owns Overview; `#automations` owns list and `#automations/<returned id>` owns the dedicated definition/builder view. Subviews (create, choose flow, test review, results) are UI states within the existing routing model; these specifications do not create backend endpoints. Configurações, Execuções and Problemas are navigation destinations only to the extent already supported; do not invent global queries. Event Explorer stays under **Avançado / Diagnóstico avançado**.

| Target → action | State / focus / result |
|---|---|
| Visão geral / Automações | Navigate to existing route; focus main heading. Set aria-current. Back to list restores filters, scroll and originating row; fall back to list heading. |
| Menu / Fechar menu | Toggle in-flow navigation with aria-expanded and aria-controls. Opening keeps focus at toggle; next Tab enters links. Escape/close collapses and restores Menu focus. No focus trap. |
| Period selector | Native select with 24h/7d/30d; request selected period. Keep focus, announce loading politely. Ignore superseded responses. Error never becomes zero. |
| Atualizar / Tentar novamente | Refresh query only; never send event. Initial load shows static skeleton; refresh preserves prior values marked Desatualizado. Confirmed zero uses R21-02; failed initial load R21-04. |
| Search / status filter | Named native input/select; query existing list, reset cursor on changed filters. Keep typing focus; reject stale responses. Empty initial list offers create; filtered empty offers Limpar filtros. |
| Carregar mais | Only render when nextCursor exists. Append confirmed next page, retain filters/focus; disable duplicate request. Failure preserves rows and offers retry of same cursor. |
| Automation name | Open returned internal ID; focus builder heading. UUID is never a required user entry or primary label. |
| Criar automação | Open create state; focus Nome. Form contains name and human-readable current routing context, no technical IDs. If no app context is known, require a named context value instead of inventing one. |
| Criar desativada | Validate existing limits (name 200 code points; context 128), focus first invalid field; send once, show Criando…; error preserves values. On confirmed response open returned definition, focus heading, announce Desativada. Unknown response does not prove creation failure; no blind automatic repeat. |
| Cancelar / back with dirty changes | Confirm discard with Ficar / Descartar; cancel restores invoker. Do not clear local draft implicitly. |
| Escolher fluxo / Usar condição guiada | Disabled when active. For disabled definition prepare fixed v2 graph locally, focus Condition inspector heading; selection does not save/activate. Confirm before replacing dirty graph. |
| Trigger / Action / End node | Native button selects node and shows read-only inspector explaining its fixed role; no delete/connect/drag dependency. Focus remains on selected node; next keyboard task can enter inspector. |
| Condition node | Select and label “Condição selecionada”; keep node focus, next inspector entry goes to Campo. Mobile scroll to inspector only on explicit selection, instant with reduced motion. No background focus changes. |
| Campo / Operador / Tipo / Valor | Native labels/selects/inputs. Operators: equals, not_equals, greater_than, less_than, contains, exists with readable Portuguese labels. Greater/less require finite number; contains fixes Texto; exists removes expected type/value; null needs no text input. Preserve inactive field drafts locally, never serialize forbidden fields. |
| Aplicar condição | Validate field path and type/value; first invalid receives focus and described error. Valid application updates local graph only, keeps focus on Apply and announces unsaved changes. Inspector edits must be applied or explicitly discarded before selecting another node/saving. |
| Salvar alterações | Only disabled/editable, valid applied dirty graph, no pending/conflict/gate. Saving… prevents duplicate. PUT expectedRevision; confirmed revision becomes saved disabled. Keep focus and announce success. Error retains graph; 400 maps issues to fields/nodes; 409 locks mutation, preserves draft and offers reload with discard confirmation. |
| Ativar / Desativar para editar | Valid clean saved graph required. Confirm activation through response before showing Ativa. While active editor is read-only. Deactivation enables editing only after confirmed revision and does not cancel accepted events. Failure preserves server-confirmed state. |
| Testar | Enabled only saved, clean, active, supported context/capabilities and ready runtime. Otherwise gray treatment plus visible reason and remediation (Salvar / Ativar / Configurações); never terminal instructions. Open review form and focus message. |
| Revisar teste / Enviar | Show message/context, scope-wide effect, saved-revision-at-acceptance notice. Sending uses existing test-event contract and one intention/key; prevent repeated click. Acceptance navigates to result state and focuses result heading. Timeout/uncertain acceptance preserves same key for reconciliation; never silently sends a new event. |
| Abrir execução / Ver detalhes | Open internally returned execution, focus heading. Expanded technical details optional/collapsed; ordinary outcome never requires raw JSON. |
| Repetir teste | Return to reviewed prefilled form for a new intention/event; explicitly not retry/redrive of the old event. Recheck revision/readiness. |

Keyboard order: skip-to-main → navigation → page heading (programmatically focused, not an extra normal Tab stop) → page filters/actions → ordered node buttons (Trigger, Condition, Action, End) → selected inspector fields → Apply → result actions. On mobile the same logical order follows stacked visual order. Save/activate/test toolbar precedes graph in desktop DOM; mobile may place it after inspector as drawn, with no positive tabindex. Background refresh never moves focus or scroll. Use semantic headings, lists/tables, real buttons/links, fieldsets and described errors. Announce material changes once, politely; submit/query failures use alert where appropriate. Disabled reasons must be visible without hover. Reduced motion: no animated pan, pulsing skeleton, progress or required transition. All load/error/offline states preserve user-entered values.

### Component/state matrix

Native set `Rescue / Operational state` contains 24 variants. First-slice variants: Draft, Saving, SaveError, SavedDisabled, Activating, ActiveReadonly, Conflict, TestUnavailable, Submitting, UnknownAcceptance, Accepted, Published, NoResult, TrueCompleted, FalseIgnored, RetryScheduled, RetryReleased, Blocked, QueryLoading, QueryError, Stale. Deferred v3 variants: ViaCEPGate, PreviewAuthorized, PreviewLoading.

| Result evidence | Presentation |
|---|---|
| accepted; publication unconfirmed | Aceito · aguardando envio. No processing/progress claim. |
| confirmed publication; no result | Enviado · aguardando resultado. No invented running status. |
| decision TRUE + action executed + valid receipt | TRUE / Verdadeiro · Concluído; render returned message. |
| decision FALSE + ignored | FALSE / Falso · Ignorado; condition not met, no receipt/action claim. |
| retry_scheduled | Aguardando nova tentativa automática; eligible date if known is not deadline. |
| retry_released | Nova tentativa na fila; say enviada only with evidence specific to this retry. |
| blocked | Interrompido · precisa de atenção; translate returned reason. No manual redrive without permission contract. |
| null result / empty limited list | Resultado ainda indisponível, not zero matches. |
| query failure after data | Desatualizado + preserved result + retry query, never resend event. |

### Frontend implementation sequence — first slice only

1. Apply existing Industrial Dark tokens and semantic shell; desktop sidebar, in-flow mobile Menu, skip link/focus and responsive content. Do not rebuild backend.
2. Wire Overview to current `/overview` fields. Deliver period selection, static loading, confirmed zero, initial error and stale refresh before charts. Add only returned bucket bars plus accessible table, recent and attention rows; no fabricated metrics.
3. Wire existing automation summary list/create/detail: readable names/context/state, filters, real cursor pagination, preserved query state and create-disabled confirmation.
4. Make definition view the dedicated full-width builder. Add explicit guided-v2 choice over existing disabled v1, fixed topology, node selection/read-only role inspectors and validated Condition inspector. No arbitrary canvas tooling.
5. Wire local Apply → revision-checked Save → confirmed Activate, active read-only/deactivate, dirty navigation and conflict guards. Implement pending and failure states before enabling mutation buttons.
6. Wire existing test-event intention/readiness gates, review/send and result panel. Keep publication separate from decision/action/retry; persist idempotency through uncertain acceptance. Repeating a test is a new reviewed event.
7. QA at desktop and 320px, 200% text, keyboard/screen reader and reduced motion. Exercise loading/zero/error/stale, search/cursor races, validation, save conflict, inactive/dirty/degraded test, uncertain acceptance, TRUE/FALSE and event-scoped retry. Lead must review the design result/criteria and subsequent browser evidence; these native studies are not executed application proof.

### Validation and deferred increment

OpenPencil representative exports inspected directly: R21-01 desktop Overview; R21-07 320 Overview; R22-01 desktop builder; R22-05 320 builder; R23-01 and R23-06 (already-created next increment). The initial desktop graph export exposed mispositioned SVG connectors; replaced them with native decorative rules and re-rendered: Trigger/TRUE/FALSE/action-to-end connections now align. Disabled activate/test controls were rendered distinctly. No screenshots are substituted for editable frames.

Final native accessibility lint on pages 21/22/23/24: **0 errors, 0 warnings, 0 info**. Parent-overflow analysis: **0** on each page. Font inspection: bundled Inter Regular, faithful=true, no substitutions. Nine interim small-target reports were decorative connector naming false positives (no interactive edges); names corrected, lint rerun. Native checks do not establish browser semantics, zoom compliance, usability or WCAG conformance.

**Next increment only:** page 23 — Rescue / ViaCEP v3 (`:7`) already contains R23-01 fixed CEP (`:497`), R23-02 event CEP/validation (`:534`), R23-03 authorization preview (`:568`), R23-04 address/alternatives (`:592`), R23-05 gate remediation (`:624`), R23-06 mobile (`:654`). Desktop 1440×1100; mobile 320×1240. Do not expand or implement these in the first slice. The native preview is explicitly contract-gated: no standalone authorized preview endpoint/permission contract was found, and the current frontend Execution parser accepts v1/v2 only despite backend v3 result types. Do not invent an endpoint, treat local consent as authorization, or fetch ViaCEP directly from the browser. These are integration gaps for the next increment, not blockers to the first-slice layout/handoff.

---

## Historical Phase 2 handoff (retained, not approval of the rescue above)

**Status:** approved by the Lead as the Phase 2 implementation handoff; runtime and accessibility QA remain pending. Native source: `design/openpencil/intelifluxo.fig`, OpenPencil only. Existing pages 00–17, including approved ViaCEP pages 16–17 and `viacep-handoff.md`, were not edited. No frontend implementation, commit or push.

## Evidence and visual direction

- Requirements: Lead-approved scope-wide acceptance architecture and authoritative Product Experience Overhaul supplied in this task. No interviews, usability findings or live provider results supplied or invented.
- Inspected existing native pages/components/tokens and `frontend/src/api.ts`, `automation-api.ts`, `Automations.tsx`. These are evidence, not permission to implement new backend contracts.
- Continue **Industrial Dark / Technical Precision**, Inter and existing `color/*`, `builder/*`, body/helper tokens. Existing `Dashboard / Create Automation` component is instantiated in AT02. New reusable `AppFlow / Operational state / State` contains 18 native variants. Colors and body/helper typography are variable-bound; no replacement palette.

## Native artifact index

Names are stable lookup keys; IDs below are session evidence and may remap after serialization/reopen. Document was `tab-1` during editing.

| Page | Frames/components | Current IDs |
|---|---|---|
| **18 — App-driven / Flow & IA** | AF01 / IA & end-to-end flow / Review target; AF02 / Wireframes / Hierarchy study; AF03 / Product overhaul IA and lifecycle | page `1798245162:5`; frames `:11`, `:45`, `:733` |
| **19 — App-driven / Screens & Responsive** | AD01 / Builder ready / Desktop 1440 | page `1798245162:6`; frame `:77` |
| same | AD02 / Test form / Desktop 1440; AD03 / Accepted event / Desktop 1440 | `:109`, `:141` |
| same | AD04 / Event results TRUE FALSE peers / Desktop 1440; AD05 / History interim / Desktop 1440; AD06 / Run detail / Desktop 1440 | `:171`, `:212`, `:246` |
| same | AD07 / Create supported automation / Desktop 1440; AD08 / Degraded runtime and disabled test / Desktop 1440 | `:677`, `:809` |
| same | AX01 / Overview truthful / Desktop 1440; AX02 / Executions discoverable interim / Desktop 1440 | `:278`, `:308` |
| same | AX03 / Problems permitted recovery / Desktop 1440; AX04 / Settings and integrations / Desktop 1440; AX05 / Final execution discovery contract gated / Desktop 1440 | `:336`, `:365`, `:701` |
| same | AM01 / Test form / Mobile 320 reflow; AM02 / Event retry / Mobile 320; AM03 / Navigation / Mobile 390 | `:504`, `:527`, `:552` |
| same | AM04 / ViaCEP local mock / Mobile 390; AM05 / ViaCEP error recovery / Mobile 320; AM06 / Human result / 320 text 200 percent study | `:572`, `:595`, `:825` |
| same | AT01 / Results / Tablet 768; AT02 / Automations list / Tablet 1024 | `:613`, `:641` |
| **20 — App-driven / States & Handoff** | AppFlow / Operational state / State; AH01 / Implementation behavior and accessibility; AH02 / Problem taxonomy and permitted recovery | page `1798245162:7`; nodes `:503`, `:765`, `:842` |

All shortened node IDs in the table have prefix `1798245162`. State variants: Inactive, Unsaved, SnapshotsOff, UnsupportedScope, RuntimeDegraded, Loading, Empty, ZeroConfirmed, Error, Offline, Conflict, UnknownAcceptance, Stale, Paused, RetryScheduled, RetryReleased, Stopped, Submitting. The internal variant name Inactive retains existing terminology; user-facing copy is **Desativada**.

## IA and lifecycle

Primary navigation: **Visão geral / Automações / Execuções / Problemas / Configurações e integrações**. Overview orients; Automations owns the critical task. Former Event Explorer becomes secondary **Diagnóstico avançado**, accessible through Settings and collapsed technical details—not a required UUID-entry step.

| Label | Exact semantics |
|---|---|
| Rascunho / Draft | Local new unsaved definition or unsaved edits over a saved revision. Not another backend status; no remote draft or parallel published/draft revision model exists in the inspected contract. |
| Ativa / Active | Persisted `active=true`, server-confirmed revision. Eligible for selection by new matching accepted events; active definition is not directly editable. |
| Desativada / Disabled | Persisted `active=false`. Not selected by new acceptances; does not cancel or pause previously accepted event snapshots. Saved definition and local dirty edits must be labeled separately. |

Create saves a **disabled** definition, not a remote draft. To change an active workflow: deactivate → edit supported Builder → save valid graph → activate with revision checks. Preserve conflict/navigation guards; never silently discard drafts. Runtime degraded/unknown is a separate environment state, not an automation lifecycle state. Do not introduce RBAC or tenant isolation claims.

## Critical journey and interaction contract

1. Existing Automations list → **Criar automação** → supported local receipt template, name/context → **Criar desativada**. Configure using existing Builder/condition controls, save, then activate. Confirm only after server response.
2. Definition offers **Enviar evento de teste** and **Histórico da automação**. Disable test for unsaved/dirty/inactive definition, snapshots off, unsupported scope, runtime degraded/unknown and pending acceptance. Explain every relevant reason with an appropriate app destination; never prescribe terminal/npm/relay/scheduler work to the ordinary user.
3. Test is a page, not a JSON editor: visible prefilled `scope` as routing context, editable message string; fixed hidden `type=receipt.v1`, `target=local-receipt`; no arbitrary `data` editor. Backend owns authoritative message constraints; no invented max length.
4. Before acceptance: **all matching active automations in this scope may run**, not only the current automation. The **saved active revision at acceptance** is used, never unsaved edits. Event is real within the local synthetic environment.
5. App generates an idempotency key for one send intention and preserves it through pending/uncertain acceptance. Prevent duplicate click. Timeout is not confirmed failure: reconcile or retry the same acceptance with the same key using the approved contract. Do not automatically create a different event.
6. Confirmed acceptance automatically opens human-readable event/run view and focuses its heading. IDs are passed internally. Show publication separately from each automation result; do not fabricate active processing, progress, duration or timestamps.
7. Open current run, peer runs, automation and its history directly. **Repetir teste** returns to a prefilled form for review and a **new event/new key**. Recheck current active revision/readiness. It is not recovery of a blocked event.

### Status mapping and branches

| Evidence | Human copy / behavior |
|---|---|
| accepted + publication pending | **Aceito — aguardando envio** |
| accepted + publication confirmed | **Enviado — aguardando resultado** |
| retry_scheduled | **Aguardando nova tentativa automática**. `nextEligibleAt`, when present, is the earliest opportunity, not a deadline. No countdown promise. |
| retry_released | **Nova tentativa na fila**; say **enviada** only with publication evidence specific to that retry. Original event publication confirmation must not prove retry publication. |
| completed / receipt, or TRUE + action executed | **Concluído**; show readable receipt message. |
| ignored + FALSE | **Ignorado — condição não atendida**; no action/receipt claimed. |
| blocked | **Interrompido — precisa de atenção**; translate known permanent/unknown/exhausted cause. |
| No executions returned | Partial/possibly pending list, **not** proof of zero matches. |
| Explicit authoritative zero-match evidence | **Nenhuma automação correspondeu**; publication success does not imply an automation ran. Currently contract-gated. |
| Multiple peers | Separate name, used revision, result and links for every returned run. Keep successful/ignored peers visible even if event or another peer fails. Never imply complete coverage from a limited list. |

Publication and execution may coexist in different states: never flatten publication failure/wait into an invented run state. `createdAt` is creation only; do not relabel it start/end or derive processing duration from polling.

### Polling, failures and recovery

Polling is background behavior, not a user control panel. Keep focus/scroll stable. Relevant state changes use polite live announcements; query errors use appropriate alerts. Expose **Atualizar**, **Continuar atualizações**, or reconnect only in useful states. Query refresh never sends an event.

Loading is not empty. Stale/paused/offline/error preserve the message and clearly label previous results as not current. Show last update only if actually known. Conflict preserves/locks local edits; reload requires discard confirmation. Unknown acceptance requires key-preserving recovery, not blind repeat.

**Problems:** failed describes a confirmed attempt failure; retrying maps scheduled/released; exhausted is a confirmed blocked reason; blocked is persisted status; awaiting intervention is human presentation, not a new backend state. Currently permit navigation, inspection and supported definition editing only. Automatic retries need no terminal. Manual event retry/redrive/unblock is **not offered without an explicit permitted-action contract**, including eligibility and effects on peers; if later supported, confirmation must describe event-wide effects. Repeating a test is explicitly a different operation.

## Truthful product surfaces and contract gaps

- **Overview:** real `/status` profile/limitations only. That response does not establish service health. Show unavailable/error honestly. Volumes, success rate, durations, latency, trends and totals stay **indisponíveis** until aggregation contracts exist. No invented charts or metrics.
- **Executions/history interim:** discover through automation selection/history and automatic event navigation. Existing execution list is limited, not guaranteed newest-first or complete; label that prominently. No fake global search/filter/pagination controls.
- **Final experience (AX05):** server-backed search by agreed message/name fields, status/automation/creation-period filters, stable newest-first cursor pagination; preserve filters/position on return. Define time zone and creation-time source with Backend. Do not add duration column/filter until measured data exists. No invented totals.
- **Problems:** no verified global query/coverage contract; cannot claim zero global problems from opened/limited runs. Global problems filtering/actions require Backend review.
- **Settings:** read-only real supported capabilities/status, not relay controls or secret/environment editors. Critical journey requires a readiness/capability contract for API/publication/processing/retry services, snapshots and supported scopes; absence is unknown, never healthy.
- Event acceptance, idempotency recovery, event→run correlation/coverage, retry-attempt publication evidence, permitted recovery and runtime readiness need confirmed integration contracts. This handoff specifies behavior, **not new endpoints or backend architecture**.
- **ViaCEP:** AM04/AM05 supplement—not replace—approved pages. Explicit **LOCAL / MOCK**, fictitious labeled address fields (logradouro, complemento, bairro, cidade, UF, CEP), real outbound disabled. Invalid CEP gets field error; mock not-found allows correction/example selection; mock timeout/unavailable preserves input and retries simulation only. No provider enablement, secrets, live address or outbound-success claim.

## Responsive/accessibility acceptance

- Desktop ≥1200: primary horizontal navigation, clear publication/result hierarchy. Tablet 768–1199: menu, 1–2-column cards. Mobile ≤767: one column, test form as page, wrapping controls, ordinary flow independent of graph dragging.
- 320 CSS px and text 200%: auto-height/wrapping, no essential truncation/horizontal page scroll; long messages/names/context wrap anywhere. AM06 is a native enlarged-text study, not proof of browser zoom compliance.
- Targets ≥44×44 CSS px (new controls drawn 48px); enlarge controls when text wraps. Visible 2px focus ring with 2px separation, ≥3:1 contrast; normal text ≥4.5:1. Existing palette retained. Do not use color alone.
- Native buttons/links/inputs, explicit labels and described validation; first invalid field receives focus after submission. `aria-current` for navigation; skip link. Menu closing restores invoker; if modal, trap focus/background inert/Escape restore.
- Acceptance navigates/focuses event heading; run opening focuses run heading; return restores invoker or list heading if absent. Background updates do not move focus. Use reduced-motion behavior, not required transitions.
- **Detalhes técnicos** collapsed by default: technical UUIDs, raw payload/result, generation/classification/codes only from actual responses; never secrets. Disclosure has keyboard support and `aria-expanded`. Ordinary task requires none of it.

## Validation and approval boundary

Executed on new pages 18–20: page trees, accessibility and recommended lint, font status and parent-overflow analysis. Accessibility: **0 errors / 0 warnings / 0 info** on each page. Parent overflow: **0** on each. Inter Regular: bundled, **faithful=true**, no substitutions/issues.

Recommended lint: **0 errors / 0 warnings**, informational findings **62 / 188 / 71** respectively, no safe fixes outstanding. Remaining info is fixed-position study layouts and heading typography without variable bindings; not a claim of fluid native auto-layout. Bound matching color tokens and body/helper typography without changing old pages. Responsive implementation must follow rules above, not copy absolute canvas coordinates.

Visual exports inspected: AD04 desktop peer results, AM01 320px form, AM04 mock address, AM06 enlarged text, AT01 tablet results, and technical disclosure control. Export revealed an invisible disclosure glyph; replaced it with `+ Detalhes técnicos` and re-exported the control successfully. Exports were returned by MCP, not added as substitute design files.

**Prototype limitation:** connected OpenPencil catalog has no screen-navigation/reaction authoring API. Native editable screens, variants and flow annotations exist; **no clickable end-to-end navigation prototype** is claimed. Isolated control behaviors are not equivalent.

Lead approval covers IA, copy and the documented contract gaps for Phase 2 implementation. Pending: Backend integration review; Frontend responsive implementation; QA keyboard/screen-reader/focus/zoom/network/idempotency/race/peer validation. No implemented behavior, WCAG compliance, usability validation or production readiness claimed.
