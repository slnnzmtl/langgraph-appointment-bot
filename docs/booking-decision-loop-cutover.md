# Booking decision-loop cutover (DDD-278A / 278B)

## Compatibility release (6A)

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
- `pausedHitl` — threads with `mutation_confirm` / frozen `pendingCommand` / pending writes
- `counts`:
  - `already_current`
  - `upgrade`
  - `prefetch_required`
  - `slot_revalidation`
  - `expired_hitl`
  - `recovered_partial`
  - `rejected`

Programmatic helpers: `scanBookingCheckpoints`, `classifyUpgradeForScan`, `emptyBookingCheckpointScanCounts` in [`src/graph/booking-checkpoint-scanner.ts`](../src/graph/booking-checkpoint-scanner.ts).

Never log patient text, phone numbers, or names from the scanner.

### Resume policy

Legacy `confirm_booking` interrupts resume via expired-confirmation recovery (`recoverExpiredConfirmBookingHitl` / composition `resumeConfirmBookingHitl`): preserve facts, clear frozen command, mark slot unverified, ask the patient to confirm again on a new v2 interrupt. Never silent-approve.

Replay checklist before cutover:

1. Load a paused HITL checkpoint on the Phase 5 graph (`booking__tools` still present).
2. Assert recovery path — no CRM write, no missing-node error.
3. Confirm schema 0/1 rows upgrade to 2 on the next patient turn.

## Post-window cleanup (6B) — gated

**Do not merge** while production can present schema 0/1 rows or paused pre-v2 interrupts.

Gate: scanner reports `pausedHitl === 0` and no `upgrade` / `expired_hitl` volume for a sustained window (or an offline migration has completed).

When the gate is met:

1. Remove deprecated booking state channel readers and interrupt aliases.
2. Optional rename `bookingDraft` → `bookingSession`.
3. Remove compatibility-only tests and leftover prompt workflow rules.
4. Update `AGENT.md` for the final topology.
