# Graph architecture review (dev, 2026-10-23)

## Structure

The graph root holds assembly and public contracts (`compile.ts`, `state.ts`, `routing.ts`, `types.ts`, `index.ts`, tool boundaries). Existing code is grouped by owner:

| Directory | Owner |
| --- | --- |
| `booking-domain/` | Booking decisions, typed intents/effects, availability presentation |
| `booking/` | Draft/session policy, interaction rendering, cancellation command, checkpoint migration |
| `catalog/` | Catalog read, matching, candidate selection, FAQ catalog policy |
| `context/` | Message history and model-context helpers |
| `agent-loop/` | LangGraph nodes, contact command, tool protocol/effects, response |
| `supervisor/` | Supervisor policy and routing |

The directory moves update imports; `compile.ts` also drops redundant constant aliases. Persisted state keys, node names, route values, and tool names are unchanged. Dependency-cruiser now prevents feature code from importing transport/bootstrap code, booking decisions from importing graph runtime, and booking/catalog policy from importing agent-loop adapters.

## Anti-patterns and simplification targets

| Evidence | Problem | Simplest next change |
| --- | --- | --- |
| `booking-domain/decide.ts` (1,513 lines) | One function handles service, schedule, contact, mutation and cards; it reads `kyivToday()` at line 997, so replay depends on the clock. | Pass clinic day as input. Collapse repeated branch guards and use the existing `requirement.ts` and availability helpers. Extract a phase only if that **reduces** branching and imports. |
| `booking/booking-draft.ts` (1,105 lines) and `booking/booking-session.ts` (1,331 lines) | Stored `phase` has live readers; interaction projection overlaps draft waits but also retains shown choices and FAQ-owned waits. | Derive runtime requirements from the draft, retaining schema-2 `phase` compatibility. Keep interaction snapshots/FAQ ownership; consolidate only redundant booking-owned decisions. Do not delete these fields as generic duplicate state. |
| `agent-loop/booking-decide-nodes.ts` (799 lines) | A node mixes hydration, catalog narrowing, decision, effect stamping, and state updates. Retry/HITL behavior is hard to follow. | Consolidate repeated input construction and decision calls in place. Move only deterministic, runtime-independent calculations inward. Tool-message parsing, `ClinicState` mapping, effect stamping, `Overwrite`, and routing remain in `agent-loop`. |
| `booking/booking-checkpoint-upgrade.ts` (745 lines) | Validation, recovery, and telemetry are intertwined. | Do not rewrite during layout cleanup. When migration is due, make validation/recovery steps explicit inside the existing module; remove old paths only after the scanner gate. |
| `catalog/service-resolution.ts` (620 lines) | Fetch, selection, and candidate grouping coexist; coexistence alone is not a defect. | Audit overlapping grouping/fallback branches before calling them redundant. Preserve complete-catalog reads, allowlisted IDs, bounded pages and shrinking drill-down. Split only for an evidenced responsibility boundary. |
| `state.ts` | `next` is `string | undefined`; legacy projections coexist with `bookingDraft`; message trimming runs in the reducer. | Narrow routes to `ClinicRouteId`. Retire legacy fields only after scanner evidence. Verify reducer replay/merge behavior before moving trimming. |

**Good foundations:** strict NodeNext TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), discriminated decision/effect unions, explicit LangGraph annotations, injected models/tools, stable `booking__tools` HITL identity, and tests for checkpoint recovery and effect-result allowlisting.

## Standards and boundaries

- A node returns a `ClinicStateUpdate` patch and does not mutate input state. Document ownership by path: booking decide applies draft events; FAQ entry/session policy may seed offers; hydration and expired-HITL recovery are explicit compatibility exceptions. Tool read-model projectors must not become another booking-draft writer. Keep deliberate reducer/reset semantics.
- Conditional routes are finite, typed values covered by the edge map—not strings inferred from patient-facing text.
- Decisions consume validated read models and emit events/effects. LLM wording cannot change facts or mutation outcomes. Effect IDs and tool-call IDs remain stable across retries.
- Keep checkpoint schema and `booking__tools` resume target until the [cutover gate](booking-decision-loop-cutover.md) is met. Never silently replay a pending write after HITL recovery.
- Keep `.js` imports under NodeNext, `import type` for type edges, exhaustive unions for decisions/effects, and validation at CRM/LLM ingress. Avoid broad `any` or speculative wrappers.

## Verified order of work

1. **Small runtime cleanup first:** remove unused `_commandPrepareName` / `_noteOrchestratorName` routing arguments and unused option fields (`commandPrepareName`, `noteOrchestratorName`, `faqPrepareName`). `compile.ts` is the sole production caller of prepare/LLM routing; it currently supplies two `undefined` placeholders. Update callers and routing tests together. Do not delete live `mutationFinalizeName` behavior by association. No new wrapper or router abstraction.
2. **Make clock input explicit:** supply a required clinic-day value through the existing decision/read-model contract, calculated once per booking-node invocation and shared by every `decideBooking` call in that invocation. No hidden default clock in the kernel. Test identical input across different system dates, plus before/on/after-anchor cases around Kyiv midnight. This makes a decision deterministic for explicit inputs; cross-resume replay still needs the same supplied day, not a new clock read.
3. **Consolidate decisions in place:** reduce repeated input construction and guards without changing branch precedence. Do not replace the event-reduced working draft with parallel state. Keep pure booking/catalog policy inward and tool protocol, stamping, read-model mapping and state patches in `agent-loop`. Reuse existing functions before creating modules.
4. **Unify requirement reads without a schema change:** inventory direct `.phase` consumers and characterize their behavior, then use the existing `bookingDraftPhase` / `nextBookingRequirement` derivation where equivalent. Keep writing compatible schema-2 `phase`. Preserve `pendingDecision` as the booking wait authority, `serviceAcceptance` and note status as domain facts, and `pendingInteraction` as the shown-view projection with FAQ-owned waits and immutable availability snapshots.
5. **Defer state removal and migration cleanup:** retiring top-level legacy channels requires the existing production scanner gate. Removing `BookingDraft.phase` additionally needs all runtime readers changed and an explicit reader/writer compatibility policy: schema-2 current rows bypass legacy decoding, while legacy decoding requires `phase`. A schema-0/1 volume gate alone does not authorize changing schema-2 payloads. No production scanner evidence was collected in this review.
6. **Catalog only if justified:** simplify proven equivalent branches, preserving complete-catalog-before-ranking, current offered-choice allowlists, same-service selection closing its wait, bounded/reachable pages, and canonical CRM names. Avoid splitting on file length.

Each implementation step must remove a concrete branch, duplicate state read, obsolete parameter, or indirection; report what disappeared. Fewer lines alone are not proof if ownership or retry behavior becomes harder to follow. Keep directory moves and semantic changes independently reviewable.

## Verification gates

- **Topology/layout:** compare node IDs and edge destinations, preserve `booking__tools`, state channel names, tool names and IDs. Run compile/routing tests and dependency-cruiser. The existing rules check direct imports; passing them is not proof of transitive domain purity.
- **State/decisions:** test service acceptance, same-service catalog reselection, DATE/TIME navigation, empty/failed availability, note/contact continuation, FAQ detours and main-menu exit. Retain alias/choice identity and the snapshot the patient actually saw.
- **Effects/HITL:** before semantic refactors, add a test through `compileClinicGraph` with fake model/CRM dependencies and the existing checkpointer: prepare → interrupt → resume → exactly one write → consume result → respond. Include decline, expired confirmation (zero writes), and failed/mismatched result recovery without silent approval. Existing adapter/tool interrupt tests and composition recovery unit tests do not establish the complete compiled booking path. Test retry behavior separately from intentional new attempts; never weaken fail-closed checks merely to reuse IDs.
- **Schema removal:** preserve current/legacy checkpoint fixtures and unsupported-version handling; pass the documented production scanner gate and a separate schema compatibility decision before field removal. Do not run production write smoke tests for a plan review.
- **Checks per step:** `pnpm check`, `pnpm test`, `pnpm depcruise`, and `git diff --check`; test package changes with `pnpm test:all` when applicable.

## Verification result (2026-10-23)

Reviewed the working tree on `dev` at base `e948b89` (uncommitted layout/alias changes included). Direction is valid **with the corrections above**; schema deletion remains deferred, not approved by this review.

Evidence behind the corrections:

- `booking-domain/requirement.ts:27–33` already delegates to `bookingDraftPhase`; do not add a second requirement engine.
- `booking/booking-interaction-policy.ts:49–57`, `booking/booking-interaction-restore.ts:72–94`, and `agent-loop/booking-decide-nodes.ts:636` still read stored `phase`. Legacy validation requires it at `booking/booking-checkpoint-upgrade.ts:384`; current schema returns unchanged at line 565.
- `agent-loop/project-pending-interaction.ts:170–193` preserves the prior shown interaction during effects and retains FAQ-owned catalog waits. `booking/booking-session.ts:98–121` stores immutable availability render snapshots. These are not disposable duplicate facts.
- `agent-loop/routing.ts:27–54, 96–103` contains the obsolete routing API slots; `compile.ts:214–222` is the placeholder-bearing caller.
- `booking-domain/decide.ts:997` reads the clock; `agent-loop/booking-decide-nodes.ts:151–201` is the existing read-model input boundary.

Fresh baseline: **81 test files / 1,026 tests pass**, `pnpm check` passes, dependency-cruiser has **0 errors / 2 existing orphan warnings**, staged/unstaged whitespace checks pass. These establish the current baseline, not correctness of future semantic changes. No application code changed during this plan verification.
