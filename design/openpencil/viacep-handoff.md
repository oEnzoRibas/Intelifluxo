# ViaCEP visual design — final design handoff

Status: **final design handoff reviewed, persisted and approved by the Lead for frontend implementation**.
Native target: `design/openpencil/intelifluxo.fig`, OpenPencil document `tab-1`.
Date: 2026-11-11. This artifact does not authorize rollout or feature enablement.

## Delivery and tooling history

An earlier OpenPencil disconnection interrupted finalization. The Lead subsequently
saved the official file (1,595,969 bytes), reconnected and verified the persisted
page trees and complete inventory. This final review updates stale references
after import/reopen remapped node IDs. No alternative platform was used.

Cross-frame clickable prototype authoring is a separate, accepted tooling gap,
not a design blocker. No clickable connections are claimed.

## Evidence and direction

Source: repository `docs/adr/0005-viacep-address-lookup.md`, especially graph/input,
result, failure, retry, gate and history contracts; ADR 0003 for condition context.
The existing file already contained V01–V03 and existing builder components.
No user interviews or runtime/provider validation were performed. All new
history examples are explicitly synthetic; revision 7 is illustrative.

Direction: reuse the dark operations UI, Inter, high-contrast semantic text,
explicit source labels, fixed graph and progressive disclosure via inspector.
No generic HTTP controls, endpoint editing, headers, credentials, remote write
status, per-node timeline, dragging requirement or per-node retry action.

Primary flow: configure Trigger → ViaCEP Lookup → Condition; TRUE → Action → End;
FALSE → End. Exactly five nodes/five edges, not an extensible DAG editor.
Apply updates local draft only; save persists the complete supported definition;
activation requires saved valid data and both gates. Inspector data never
implies runtime success. History reads the pinned revision and persisted result.

## Native inventory

Use stable page names and frame/component names as implementation references.
V/H/R prefixes below uniquely identify frames on page 16. Numeric IDs are only
current-document references observed on 2026-11-11; they may remap across
import/reopen. Never resolve a node by replacing an old ID prefix.

Page `0:21`: **16 — ViaCEP / Screens & Responsive**

| Frame | Exact node ID | Purpose |
|---|---|---|
| V01 / Desktop 1440 / Lookup fixo | `0:42` | Desktop 1440, fixed CEP lookup |
| V02 / Desktop 1440 / Lookup evento | `0:100` | Desktop 1440, event CEP lookup |
| V03 / Desktop 1440 / Condição step | `0:155` | Desktop 1440, condition from lookup step |
| V04 / Desktop 1440 / Condição evento | `0:220` | Desktop 1440, condition from event |
| H01 / found / TRUE / executed | `0:284` | completed; absent/empty fields |
| H02 / found / FALSE / ignored | `0:310` | baseline receipt caveat |
| H03 / not_found / blocked | `0:336` | permanent; not FALSE |
| H04 / failed / retry_scheduled | `0:358` | timeout, pending |
| H05 / failed / retry_released | `0:380` | not completed |
| H06 / failed / exhausted | `0:402` | retry_exhausted, blocked |
| H07 / failed / permanent | `0:424` | invalid_cep, no outbound query |
| H08 / unsupported | `0:446` | lookup null, read-only |
| H09 / unavailable | `0:468` | unavailable/unvalidated history, reload |
| R01 / Mobile 390 / Builder | `0:492` | ordered node list |
| R02 / Mobile 390 / Inspector evento | `0:527` | full-screen inspector |
| R03 / Mobile 390 / History found | `0:546` | stacked execution details |
| R04 / Tablet 768 / Inline inspector | `0:569` | topology summary + inline inspector |
| H10 / accepted / no committed result | `0:591` | result null, no committed observation |
| H11 / found / TRUE / peer retry | `0:603` | found retained, pending, event_peer_failure |
| H12 / FALSE / parent blocked | `0:615` | ignored with parent event blocked |

Inspector masters are native components: fixed CEP inspector in V01, event CEP
inspector in V02, step condition inspector in V03, event condition inspector in V04.
Resolve these by their named screen context rather than historical conversion IDs.

These masters remain within desktop frames, rather than moved out of their
screen context. Existing Trigger/Action component instances were reused.

Page `0:22`: **17 — ViaCEP / Components, States & Handoff**

Native variant set `0:699` (editor-derived name `State=Validation`):

| State | Exact component ID | Intended placement / behavior |
|---|---|---|
| State=Validation | `0:700` | Inspector; invalid fixed CEP, apply unavailable |
| State=GateDisabled | `0:713` | Inspector; save/activation unavailable |
| State=ReadOnly | `0:726` | Unknown contract; preserve unknown content |
| State=Loading | `0:739` | Inspector/data region; no fabricated values |
| State=Empty | `0:752` | History region; no executions in current recorte |
| State=Error | `0:765` | Failed read; preserve draft; retry read |
| State=Focus | `0:778` | CEP focus sample; 2px outside stroke |
| State=Conflict | `0:791` | Stale revision; deliberate reload/reapply |

Native board: **N01 / Navigation, accessibility & acceptance**, current ID `0:804`.
State components are complete 416×904 contextual panels, not separately
completed desktop screen hosts. V05–V07 do not exist; complete contextual state
panels are the accepted delivery, not missing or implied full-screen hosts.

## Intended navigation (not clickable)

* V01, source control → V02; source switch preserves only deliberate
  draft changes. Fixed/event are mutually exclusive serialized unions.
* V01/V02 Condition node → V03; condition-source control → V04.
* V03 source `step` references the sole preceding lookup `address-lookup`.
  Event source V04 has no step reference control and uses root `events.content`.
* Apply in the V01–V04 inspectors returns focus to originating
  node and updates draft summary; does not save or execute anything.
* R01 lookup card → R02; Apply or Back/Esc returns to the R01 lookup card.
* Open history from R01 → existing history list; selecting an execution
  opens the applicable H01–H12. H01 maps to R03 on mobile. This continuation did
  not create a replacement history-list endpoint, pagination or discovery API.
* Invalid CEP → State=Validation, focus its CEP input; fixed corrected input
  returns to V01. Gate denial → State=GateDisabled; unsupported → State=ReadOnly.
* Initial read → State=Loading; empty history → State=Empty; read failure →
  State=Error/H09; retry repeats the read only. State=Conflict never overwrites automatically.

## Content and contract rules

* Disclosure: “Somente local · sem autenticação, autorização ou isolamento por
  tenant.” Supporting text: “Use loopback e dados sintéticos. Escopo não é uma
  fronteira de segurança.” Keep visible; never represent scope as authorization.
* CEP: “8 dígitos ou 00000-000. Sem espaços.” Use a string input, preserve leading
  zeroes and submitted fixed representation. No trim, numeric conversion,
  zero-padding, broad character removal or automatic lookup from the browser.
  Validation example was corrected to visibly invalid `0100-000`.
* Event CEP field `data.cep` resolves from `events.content`; existence/type/format
  are checked at execution, not claimed valid merely by saving the path.
* Step condition root is the persisted lookup object; example `address.uf`.
  Event condition example `data.uf`. No `steps.<id>` interpolation or merge of
  address into event content. Reuse existing operator/type rules from ADR 0003.
* Absent: display “Ausente · chave omitida”; exists=false, equality and inequality
  both false. Present empty string: display `"" · presente, vazio`; exists=true,
  equals empty=true. Provider null is invalid payload, not absent or empty.
* found does not imply action execution. Evaluate only after found, even for
  event-source conditions. not_found/error do not implicitly select FALSE.
* TRUE/executed permits completed only with valid persisted evidence. FALSE is
  ignored for this automation; baseline receipt/other executions remain separate.
* `retry_scheduled` is event-level scheduling, not automatic browser retry.
  `retry_released` is generation release, not completed processing; other retry
  fields describe preceding disposition. Display API nextEligibleAt/attempt/
  generation/reason without inventing a countdown, node timestamps or delivery.
* H04/H05 contain explanatory copy instead of a fabricated due timestamp. Render
  actual validated metadata at implementation time; null stays unavailable.
* Prior committed found observation is retained on retry; H11 demonstrates
  found + pending due to peer failure. H12 demonstrates ignored + parent blocked.
* Terminal errors/exhaustion: no per-node manual retry. Correct input and submit
  a new event identity through the supported event-entry workflow; changing the
  head definition never repairs pinned work. No new submission UI is implied.
* Gate off: v3 create/edit/activate unavailable; unchanged-graph deactivation
  remains allowed by ADR 0005. Gates never cancel already pinned work. Do not
  infer runtime capability from an enabled checkbox or from this design.
* Unsupported/unavailable: preserve unknown data; do not downgrade or synthesize
  success. No raw provider body, exception text, credentials or remote status.

## Tokens and responsive behavior

Reuse existing document tokens:

| Role | Token | Value |
|---|---|---|
| Canvas | color/canvas | #10151C |
| Panel | builder/panel | #151E28 |
| Input well | builder/well | #0B1016 |
| Raised | builder/raised | #202D3A |
| Text | color/text | #E5EDF6 |
| Supporting | color/muted | #B9C8D8 |
| Action/focus | color/action-soft | #B6D3FF |
| Warning | color/warning | #E9BA69 |
| Error | color/error | #ED8790 |
| Success | color/success | #73C7A1 |
| Control boundary | builder/control-border | #657B91 |

Native collection “ViaCEP / Layout”: space/1=8,
space/2=16, space/3=24, radius/control=8,
control/min-height=48, type/body=16, type/helper=14,
layout/inspector=416. Numeric tokens are available definitions; not every
absolute geometry field is variable-bound. Color-binding lint reported no
remaining matching hardcoded-color issues after the binding pass.

* ≥1280px: persistent navigation, canvas plus 416px inspector, 24px gutters.
* 600–1279px: navigation collapses; selected configuration flows below topology,
  not squeezed into an unreadable sidebar (R04). Summary is fixed topology,
  not a live execution timeline. Implement individual keyboard-selectable node
  controls using the ordered-list model in R01; R04 summary is illustrative.
* <600px: 16px page gutters, single column; inspector is a separate route/view
  with Back, not a trapped modal. R01/R02 preserve selected node and draft.
* History: two columns desktop; stack lookup → fields → decision → action →
  event retry on narrow layouts. State panels fill available width; text wraps,
  vertical height grows. Preserve semantic source, pinned revision and warnings.
* Native layouts are explicit editable breakpoint frames, not a proven fluid
  constraint implementation. At 320px/200% zoom wrap long IDs/paths without
  horizontal page scroll; do not truncate outcome/error/source information.
* Desktop display metadata includes inherited 12px labels; new helper text is
  14px and new body is 16px. Do not reduce text to fit. No sticky footer may
  cover focused controls; controls scroll into view with keyboard/virtual input.

## Accessibility acceptance / implementation behavior

* Real labeled controls: source selects, string CEP input, operator/type/value;
  labels and errors programmatically associated. `aria-invalid` on invalid CEP,
  error described by field; submit failure focuses first invalid field or an
  actionable error summary. Never communicate state by color alone.
* Tab order: navigation → header actions → node list in logical graph order →
  inspector fields → Apply. Enter/Space selects nodes; native select keyboard
  behavior; Shift+Tab reverses. No drag-only interaction or global shortcut that
  steals typing. End is not falsely represented as configurable.
* Esc leaves inspector, restores focus to originating node, and retains draft;
  no escape-time destructive save/discard. Back is a ≥44px target even where a
  responsive frame currently illustrates it as text.
* Minimum target 44×44px (illustrated controls generally 48px high); visible
  focus 2px with 2px offset, unobscured. State=Focus / Input / Focus has actual
  2px outside stroke; offset is an implementation acceptance requirement.
* Contrast acceptance: normal text ≥4.5:1, large text ≥3:1, essential controls
  and focus ≥3:1. Disabled reason remains legible and discoverable, not hover-only.
* Loading uses aria-busy and polite status; errors announced once. No automatic
  focus movement on retry polling or read refresh. Do not announce skeleton
  placeholders as field values. Respect reduced motion; no required animation.
* Semantic ordered node list plus explicit TRUE/FALSE branches must convey the
  graph without the visual connector lines. Address keys/values use a definition
  list or equivalent; empty vs omitted is spoken distinctly.
* Keyboard/screen-reader/zoom/contrast-on-implementation QA is still required.
  Static native lint is not evidence of real assistive-technology usability.

## Executed validation evidence — 2026-11-11

* Connected document `tab-1` matched the exclusive official path. Lead's prior
  successful save/reconnect verified persisted inventory at 1,595,969 bytes.
* After replacing N01's stale numeric references with stable names, `save_file`
  returned **saved=true** for the official path in this final review.
  Filesystem confirmation: **1,607,836 bytes**, 2026-11-11 22:29:58 local time.
  This final save was validated through post-save live trees/checks; a second
  close/reopen was not performed in this continuation.
* Lead approval was then recorded in N01 and this handoff. The official file was
  saved again successfully at **1,608,589 bytes**, 2026-11-11 22:33:02 local
  time; accessibility lint and parent-overflow analysis remained clear.
* Post-save `get_page_tree` confirmed V01–V04, H01–H12, R01–R04 on page 16,
  plus the native state set and N01 on page 17. The detailed state tree confirmed
  all eight components. No V05–V07 hosts exist or are claimed.
* Accessibility lint: **0 errors, 0 warnings, 0 info** on each official page.
* Recommended lint: **0 errors, 0 warnings** on each official page; informational
  findings remain: **527** on page 16 and **121** on page 17, principally explicit
  breakpoint frames without auto layout and typography without token bindings.
  These are not proof of fluid responsiveness; the acceptance criteria above apply.
* Post-save parent-overflow analysis: **0** across **657 nodes** on page 16;
  **0** across **138 nodes** on page 17 (including the 33-node N01 board).
  Lead's earlier 105-node page 17 evidence covered the state set.
* Font status on both pages: **faithful=true**, Inter Regular bundled,
  **no substitutions, no font issues**.
* Lead previously reviewed coherent exports of V01/H01/R01/state set/N01.
  This final review exported and visually inspected the affected N01 board:
  stable references, complete navigation/accessibility text, no clipping or
  misleading numeric IDs; layout and hierarchy remain coherent.
* No clickable interaction, runtime execution, provider query, frontend test,
  user usability test or implementation approval is claimed. Static lint does
  not validate screen-reader/keyboard behavior in a running application.

## Implementation approval and remaining QA

1. Lead approval for frontend implementation was granted on 2026-11-11 after
   review of the native result, responsive/keyboard criteria, state semantics
   and documented deviations. This does not authorize rollout, external queries
   or feature enablement.
2. Tablet node controls and header actions are specified but not exhaustively
   visualized in R04. Complete contextual panels suffice; V05–V07 are not required.
3. No cross-frame clickable prototype is delivered (accepted tooling gap).
   Follow the named navigation map; do not invent connections or runtime evidence.
4. QA independently verifies keyboard, assistive technology, 320px/200% zoom,
   contrast, responsive behavior and runtime state mapping during implementation.
   Numeric-token binding and fluid layout remain implementation responsibilities.
