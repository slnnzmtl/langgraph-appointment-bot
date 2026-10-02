# PR #21 reschedule tool error — fixing plan

## Scope

Fix the false-negative mutation result introduced by PR #21. Do not create a
Linear ticket and do not broaden the change into a general success-text
fallback.

Repository: `slnnzmtl/langgraph-appointment-bot`

Branch: `refactor/booking-state-truth`

PR: [#21](https://github.com/slnnzmtl/langgraph-appointment-bot/pull/21)

Trace: `01a0f2a9-94a5-74b9-9322-bd1aefbdade7`

## Verified failure

The trace submitted a valid reschedule command:

```json
{
  "meetingId": "6abd1856879368139",
  "dateStart": "2026-10-13T12:30:00",
  "dateEnd": "2026-10-13T13:00:00"
}
```

The HITL confirmation completed and the CRM update committed. EspoCRM returned:

```text
Successfully updated meeting with ID: 6abd1856879368139
```

PR #21 then emitted `tool_error: Mutation response did not include an entity
id` and showed the patient `Не вдалося перенести запис. Спробуйте ще раз.`.
A subsequent `Мій запис` lookup showed the meeting at the new time, proving
that the write succeeded and only the application’s success classification was
wrong.

## Root cause

Commit `d24fc95` added `requireEntityId: true` to
`finishTrackedWrite` for `create_meeting` and `reschedule_meeting`.
`jsonEntityId()` only reads a JSON object’s `id` field, but both reschedule
and cancellation call EspoCRM `update_meeting`, whose successful response is
text. Main accepted that text; PR #21 rejects it.

## Fix design

### 1. Normalize the known CRM response at the meeting-tool boundary

Add a narrow parser/normalizer for the exact successful response:

```text
Successfully updated meeting with ID: <non-empty-id>
```

The parser must:

* accept only the anchored format, with surrounding whitespace tolerated;
* extract the meeting ID;
* require it to equal the runtime-owned `meetingId` for the current command;
* return structured JSON containing the matching `meetingId` (and, if useful,
  `id`) before `finishTrackedWrite` validates the entity ID;
* leave errors, HITL pending/declined payloads, malformed text, generic success
  text, and mismatched IDs unchanged so they remain fail-closed.

Keep this normalization local to meeting mutations. Do not change generic
`jsonEntityId()` behavior and do not make `finishTrackedWrite` accept
arbitrary non-JSON success text.

### 2. Preserve outcome semantics

* Matching reschedule response: `committed`, one `meeting_rescheduled`.
* Matching cancellation response: `committed`, one `meeting_cancelled`.
* `create_meeting` continues to require a JSON entity ID.
* Missing, malformed, generic, or mismatched responses remain failures.
* HITL `cancelled` and `awaitingConfirmation` payloads remain untouched.

### 3. Keep finalization code unchanged

`classifyMeetingMutationToolMessage` already requires committed evidence.
Make the tool result satisfy that classifier; do not add a response-text
special case in graph finalization.

## Files and tests

### Production

* `src/tools/meeting-tools.ts`: add the exact `update_meeting` parser and
  apply it only to `cancel_meeting` and `reschedule_meeting`, using the
  runtime-owned command ID.
* No changes are expected in `src/graph/agent-loop.ts` or
  `src/analytics/track.ts` unless focused tests expose a contract mismatch.

### Regression coverage

* `src/tools/__tests__/meeting-tools.test.ts`
  * make the confirmed CRM mock return the production text response;
  * verify reschedule returns committed structured evidence with the requested
    meeting ID;
  * verify cancellation accepts the same response;
  * verify generic success text, malformed text, and mismatched IDs do not
    produce committed evidence or success tracking;
  * retain pending and declined HITL tests.
* `src/graph/__tests__/agent-loop.test.ts`: verify normalized reschedule
  evidence reaches the runtime-owned success message, while raw unnormalized
  text remains failed.
* Prefer not to modify `src/analytics/__tests__/track.test.ts`; retain its
  strict generic `requireEntityId` coverage.

## Acceptance criteria

1. The supplied trace’s response shape produces exactly one committed
   reschedule outcome and no missing-entity-ID `tool_error`.
2. User-visible reschedule success is emitted only when the returned ID exactly
   matches the requested meeting ID.
3. No duplicate write or retry occurs.
4. Cancellation using the same response format remains successful.
5. `create_meeting` still fails closed for generic success text,
   `{ "success": true }`, malformed text, or JSON without an entity ID.
6. Mismatched IDs, empty IDs, CRM errors, HITL pending, and HITL decline remain
   non-committed.
7. No broad success regex or model-authored success path is added.

## Validation

```bash
pnpm vitest run src/tools/__tests__/meeting-tools.test.ts \
  src/graph/__tests__/agent-loop.test.ts \
  src/analytics/__tests__/track.test.ts
pnpm check
git diff --check
```

`pnpm test:all` is not required because `packages/llm-gemini` is unchanged.

## Delivery checklist

* [ ] Implement exact response normalization.
* [ ] Add reschedule and cancellation regression tests.
* [ ] Add finalizer committed/failure coverage.
* [ ] Run focused tests, `pnpm check`, and `git diff --check`.
* [ ] Review the final diff for changes outside the mutation boundary.
* [ ] Push a follow-up commit to PR #21 and wait for required checks.
