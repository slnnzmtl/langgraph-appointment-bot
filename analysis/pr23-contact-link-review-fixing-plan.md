# PR #23 contact-linking review findings — fixing plan

## Scope

Address the three blocking review findings in PR [#23](https://github.com/slnnzmtl/langgraph-appointment-bot/pull/23) without adding a second identity model, weakening mutation authorization, or introducing broad success-text heuristics.

Repository: `slnnzmtl/langgraph-appointment-bot`  
Branch: `fix/contact-link-before-booking`  
Reviewed HEAD: `fa40b0d` (`fix: avoid duplicate booking confirmation`)  
Base: `a2832b5` (`origin/master`)

This document is an implementation plan only. It does not change runtime source code.

## Review findings to fix

### 1. Production link success is not recognized

`createAgentToolsNode` promotes a linked contact only when the tool body parses as JSON. The real `link_telegram_to_contact` wrapper returns the underlying `update_entity` result unchanged, and the repository’s contact-tool fixture models that result as:

```text
Successfully updated Contact record with ID: c-99
```

`asJsonRecord()` returns `null` for that response, so the contact remains `ownership: "phone"`. The runtime-owned continuation added by PR #23 therefore does not run on the real tool contract.

### 2. `Not authorized` recovery retains the stale ownership projection

The new authorization-failure branch applies `contact_unresolved` to `BookingDraft`, but it does not clear `contactContext`. On the next route calculation, `createCommandFromBookingDraft()` recovers the same contact ID from the still Telegram-owned context. If fresh availability evidence is present, the graph prepares and executes the same mutation again.

The recovery can therefore recurse until the graph recursion limit instead of returning to identity resolution.

### 3. Contact ownership is not committed to the booking aggregate

A successful `create_contact` or `link_telegram_to_contact` updates `contactContext` only. `bookingDraft.contactId` remains `null`.

`BookingDraft` deliberately rejects `command_prepared` for create commands when `contactId` is absent. The graph can still reach the first HITL interrupt because `createCommandFromBookingDraft()` falls back to `contactContext`, but it cannot persist the frozen command. A chat-text response to the HITL card can then no longer be recognized and replayed safely with `confirmationGiven: true`.

## Design constraints

1. Preserve `BookingDraft` as the authoritative incomplete-booking aggregate.
2. Preserve explicit contact ownership: a phone search result is only a candidate until a successful CRM link/create result proves Telegram ownership.
3. Normalize known external response formats at the tool boundary, not in generic graph classification.
4. Keep success parsing narrow and fail-closed. Do not accept arbitrary non-JSON text as a successful link.
5. A CRM authorization failure must invalidate every local projection that could immediately reconstruct the rejected command.
6. Do not retry a rejected meeting mutation in the same graph turn.
7. Preserve the existing single-HITL flow and durable chat-confirmation token protections from PR #22.
8. Do not change prompts unless a regression test proves a prompt contract must change.

---

# Implementation sequence

## Phase 0 — Add failing tests before production changes

### Files

- `src/tools/__tests__/contact-tools.test.ts`
- `src/graph/__tests__/agent-loop.test.ts`
- `src/graph/__tests__/compile-prefetch.test.ts`

### 0.1 Characterize the real link response

Extend the contact-tool test to assert the returned value from `link_telegram_to_contact`, not only the MCP call arguments.

Use the existing production-shaped response:

```text
Successfully updated Contact record with ID: c-99
```

Add negative cases for:

- a mismatched contact ID;
- generic success text without an ID;
- malformed/empty text;
- `{ "error": "..." }`;
- thrown MCP errors.

The positive response must become structured committed evidence. Negative cases must remain non-successful evidence.

### 0.2 Reproduce the production link path through the graph

Replace or supplement the synthetic JSON-returning link tool in `compile-prefetch.test.ts` with `createContactTools()` backed by a fake `callTool` whose `update_entity` response is the exact production text.

Assert:

- `update_entity` runs once with the phone-matched contact ID and injected Telegram ID;
- contact ownership becomes `telegram`;
- `bookingDraft.contactId` becomes that contact ID before command preparation;
- availability revalidation runs once;
- one meeting HITL interrupt is produced;
- the booking model is invoked only for the link call, with no conversational confirmation between link and HITL.

The test must fail on current HEAD because the plain-text link response is discarded.

### 0.3 Reproduce the authorization retry loop at routing level

The existing unit test only checks that `bookingDraft.contactId` and `pendingCommand` are cleared. Extend it so the tool-node update is applied to the prior state and passed to `routeAfterAgentTools` or, preferably, exercise the compiled graph.

Assert after `{ "error": "Not authorized" }`:

- `bookingDraft.contactId === null`;
- `bookingDraft.pendingCommand === null`;
- `contactContext === null`;
- stale `bookingContext` is not retained;
- `prefetchDirty === true`;
- `create_meeting` was invoked exactly once;
- routing does not return to command preparation;
- no recursion-limit exception occurs;
- no HITL or success response is emitted.

### 0.4 Reproduce chat confirmation after linking

Add an end-to-end compiled-graph test using a checkpoint and stable `thread_id`:

1. Start from a complete booking draft except for `contactId`, plus a phone-owned candidate.
2. Link the candidate.
3. Continue directly to the meeting HITL interrupt.
4. Resume the interrupt with `{ userReply: "Так, підтверджую" }`.
5. Verify the frozen command is persisted and replayed with `confirmationGiven: true`.

Assert:

- the CRM meeting write commits exactly once;
- no second HITL card appears;
- no slot invalidation occurs merely because the aggregate lacked the contact ID;
- the replay uses the exact frozen contact/service/date payload.

This test must fail on current HEAD because `command_prepared` rejects the contact-less aggregate.

### Phase 0 exit criteria

All three review defects have focused red tests that fail for the expected reason rather than fixture setup.

## Phase 1 — Normalize link success at the contact-tool boundary

### Files

- `src/tools/contact-tools.ts`
- `src/tools/__tests__/contact-tools.test.ts`

### Actions

1. Add a narrow normalizer for the exact successful `update_entity` response used for contacts:

   ```text
   Successfully updated Contact record with ID: <non-empty-id>
   ```

2. Anchor the parser and tolerate surrounding whitespace only.
3. Require the returned ID to equal the runtime-owned `input.contactId`.
4. Convert a matching response into structured JSON, for example:

   ```json
   {
     "success": true,
     "id": "c-99",
     "contactId": "c-99"
   }
   ```

5. Leave CRM error JSON, generic text, malformed text, empty IDs, and mismatched IDs unchanged so they fail closed.
6. Run the normalized result through `finishTrackedWrite` with entity-ID validation enabled for the link operation.
7. Keep `create_contact` on its existing structured-ID contract.
8. Do not broaden `asJsonRecord`, `jsonEntityId`, or generic write-success handling.

### Phase 1 exit criteria

The real EspoCRM link response produces structured, ID-matched success evidence; ambiguous responses cannot promote ownership.

## Phase 2 — Apply contact resolution atomically to context and draft

### Files

- `src/graph/agent-loop.ts`
- `src/graph/__tests__/agent-loop.test.ts`
- `src/graph/__tests__/compile-prefetch.test.ts`

### Actions

1. In `createAgentToolsNode`, derive a validated resolved contact ID from successful contact mutation evidence:
   - `create_contact`: structured returned entity ID;
   - `link_telegram_to_contact`: normalized returned ID, verified against the tool-call `contactId`.
2. Reuse the existing contact row reconstruction logic to set:

   ```ts
   contactContext = {
     ownership: "telegram",
     contacts: [resolvedRow],
   };
   ```

3. In the same update, apply:

   ```ts
   reduceBookingDraft(currentDraft, {
     type: "contact_resolved",
     contactId: resolvedContactId,
   });
   ```

4. Reduce from the latest projected draft in the node, not blindly from `state.bookingDraft`, so another legitimate transition in the same node is not overwritten.
5. Preserve `null` as an intentional draft clear; do not use a nullish fallback that resurrects the old draft.
6. Only mark ownership and update the draft after validated committed evidence. Tool execution alone, a tool name, or an error-free-looking but unverified body is insufficient.
7. Keep `bookingCommandContinuesAfterTools` dependent on the resolved ownership plus a now-valid aggregate.

### Phase 2 exit criteria

After successful contact creation/linking, `contactContext` and `BookingDraft` identify the same Telegram-owned contact, and `command_prepared` can persist the frozen create command.

## Phase 3 — Invalidate stale identity on authorization failure

### Files

- `src/graph/agent-loop.ts`
- `src/graph/__tests__/agent-loop.test.ts`
- `src/graph/__tests__/compile-prefetch.test.ts`

### Actions

1. When a meeting mutation returns the exact blocked error `Not authorized`, apply `contact_unresolved` to the latest projected booking draft.
2. Clear the stale prefetch projections in the same update:

   ```ts
   contactContext: null,
   bookingContext: null,
   prefetchDirty: true,
   ```

3. Ensure later processing in `createAgentToolsNode` cannot overwrite this invalidation with state derived from the rejected command.
4. Confirm that `createCommandFromBookingDraft()` returns `null` after the merged update; it must not recover the rejected ID from context.
5. Route to identity resolution/LLM once, not back to `command_prepare`.
6. On the next user turn, let the existing supervisor prefetch perform a fresh Telegram lookup because `prefetchDirty` is set.
7. Do not treat `Not authorized` as a slot failure and do not discard accepted service, selected date/slot, or completed note. Only identity and the frozen command are invalidated.
8. Apply the same fail-closed projection invalidation to create, reschedule, and cancel authorization failures because all indicate that the locally cached ownership/meeting projection cannot be trusted.

### Phase 3 exit criteria

An authorization failure executes at most once per graph turn, cannot reconstruct the rejected command locally, and preserves unrelated booking facts for recovery after identity is resolved.

## Phase 4 — End-to-end confirmation and compatibility coverage

### Files

- `src/graph/__tests__/compile-prefetch.test.ts`
- `src/graph/__tests__/agent-loop.test.ts`
- `src/graph/__tests__/booking-draft.test.ts` only if reducer behavior needs additional characterization

### Required scenarios

1. **Phone hit → link text response → fresh validation → one HITL**
   - real contact tool contract;
   - one model call;
   - one availability refresh;
   - one HITL card.
2. **Phone hit → link error**
   - remains phone-owned;
   - no draft contact resolution;
   - no create call.
3. **Phone hit → malformed or mismatched link success text**
   - fails closed;
   - no ownership promotion.
4. **New contact creation**
   - structured create ID updates context and draft atomically;
   - direct continuation remains valid.
5. **Keyboard HITL confirmation after link**
   - one CRM meeting write;
   - normal terminal success.
6. **Chat-text HITL affirmation after link**
   - frozen command persists;
   - replay carries `confirmationGiven: true`;
   - no duplicate card or duplicate write.
7. **Chat-text non-affirmative reply after link**
   - existing PR #22 cleanup semantics remain intact;
   - durable confirmation token is cleared;
   - no mutation replay.
8. **`Not authorized` with fresh availability present**
   - one create attempt only;
   - stale identity projections cleared;
   - no recursion.
9. **Legacy context without `ownership`**
   - existing backward-compatible Telegram-prefetch interpretation remains unchanged;
   - explicit phone-owned contexts remain untrusted.

### Phase 4 exit criteria

The fixes cover the production tool contract, aggregate state, graph routing, HITL keyboard path, chat-text confirmation path, and authorization recovery without weakening existing guards.

## Files expected to change

Production:

- `src/tools/contact-tools.ts`
- `src/graph/agent-loop.ts`

Tests:

- `src/tools/__tests__/contact-tools.test.ts`
- `src/graph/__tests__/agent-loop.test.ts`
- `src/graph/__tests__/compile-prefetch.test.ts`

Avoid changing `src/graph/booking-draft.ts` unless a new reducer test exposes a genuine reducer defect. The existing `contact_resolved`, `contact_unresolved`, and `command_prepared` invariants are appropriate; the graph must supply consistent events.

## Acceptance criteria

1. The production-shaped contact update response is normalized only when its ID exactly matches the requested contact ID.
2. A successful link/create updates both Telegram ownership context and `bookingDraft.contactId` in one graph update.
3. A complete post-link booking reaches exactly one fresh availability validation and one HITL card without a second model-authored confirmation.
4. Keyboard confirmation writes the meeting once.
5. Chat-text affirmation after the card replays the exact frozen command once with `confirmationGiven: true`.
6. Error, malformed, generic, empty-ID, or mismatched-ID link responses never promote ownership.
7. `Not authorized` clears stale contact/meeting projections, clears the draft contact and frozen command, marks prefetch dirty, and does not retry in the same turn.
8. Accepted service, selected slot, and completed note survive authorization recovery.
9. No broad success parser, prompt-only correctness rule, duplicate booking flow, or new state abstraction is introduced.
10. All existing confirmation replay, contact completeness, consultation agreement, slot freshness, and replacement-booking tests remain green.

## Validation

```bash
NODE_ENV=test pnpm exec vitest run \
  src/tools/__tests__/contact-tools.test.ts \
  src/graph/__tests__/booking-draft.test.ts \
  src/graph/__tests__/agent-loop.test.ts \
  src/graph/__tests__/compile-prefetch.test.ts
pnpm check
NODE_ENV=test pnpm test
git diff --check
```

`pnpm test:all` is not required unless `packages/llm-gemini` changes.

## Manual acceptance path

Use a fresh Telegram thread and a CRM contact that matches the supplied phone but has no Telegram ID:

1. Select service, date, time, and finish the optional note step.
2. Supply the contact’s clinic phone.
3. Verify the bot links the existing contact.
4. Verify no conversational “please confirm” message appears before the actual HITL card.
5. Confirm once with the keyboard; verify exactly one meeting exists.
6. Repeat with chat text (`Так, підтверджую`) instead of the keyboard; verify one write and no second card.
7. Force an ownership mismatch so `create_meeting` returns `Not authorized`; verify the bot does not loop or show repeated cards and returns to identity resolution.

## Delivery checklist

- [ ] Add red tests for all three review findings.
- [ ] Normalize exact link success response at the contact-tool boundary.
- [ ] Require an ID-matched committed link result.
- [ ] Update `contactContext` and `BookingDraft` atomically.
- [ ] Clear stale identity/meeting projections on authorization failure.
- [ ] Prove no same-turn retry after `Not authorized`.
- [ ] Prove keyboard and chat-text HITL confirmation after linking.
- [ ] Run focused tests, full tests, typecheck, and diff check.
- [ ] Review the final diff for unrelated changes.
- [ ] Push one focused follow-up commit to PR #23 and wait for required checks.
