# Booking decision-loop cutover

## Compatibility release

- Reads checkpoint schema **0/1/2**, writes **2 only**.
- Interrupt-capable node name **`booking__tools`** must remain until paused HITL volume is zero.
- Before deploy: back up `CHECKPOINT_DB_PATH`.
- Rollback: previous application binary + pre-cutover DB. No in-place schema-2 downgrade.

### Scanner

Run a non-PII dry-run against the checkpoint sqlite file:

```bash
pnpm scan:booking-checkpoints
# or
pnpm scan:booking-checkpoints -- --db /path/to/checkpoints.sqlite
```

The CLI opens `SqliteSaver`, iterates distinct `thread_id`s, and prints JSON tallies:

- `threads` — distinct thread ids inspected
- `pausedHitl` — `mutation_confirm` card/decision, frozen create/reschedule/cancel command, or pending writes that encode `confirm_booking` (not bare `pendingEffect`)
- `counts` (priority: rejected → recovered_partial → expired_hitl → slot_revalidation → prefetch_required → already_current → upgrade):
  - `already_current`
  - `upgrade`
  - `prefetch_required`
  - `slot_revalidation`
  - `expired_hitl`
  - `recovered_partial`
  - `rejected`

Programmatic helpers: `scanBookingCheckpoints`, `classifyUpgradeForScan`, `emptyBookingCheckpointScanCounts` in [`src/graph/booking-checkpoint-scanner.ts`](../src/graph/booking-checkpoint-scanner.ts). Classification calls the real `upgradeBookingDraftCheckpoint` so `recovered_partial` / `rejected` match production.

**Schema rule:** a missing `bookingSchemaVersion` channel is schema **0** (the state default), never the current `BOOKING_SCHEMA_VERSION`. Versionless drafts therefore count as `upgrade`, not `already_current`. Current-schema rows with demoted slots or missing availability still count as `slot_revalidation` / `prefetch_required` before `already_current`.

Never log patient text, phone numbers, or names from the scanner.

### Resume policy

Legacy `confirm_booking` interrupts resume via expired-confirmation recovery when live `mutation_confirm` is gone: preserve facts, clear frozen command, mark slot unverified, ask the patient to confirm again. Never silent-approve.

## Post-window cleanup — gated

**Do not merge** while production can present schema 0/1 rows or paused pre-v2 interrupts.

Gate: scanner reports `pausedHitl === 0` and no `upgrade` / `expired_hitl` volume for a sustained window.
