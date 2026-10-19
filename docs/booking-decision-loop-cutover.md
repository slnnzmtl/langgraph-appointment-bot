# Booking decision-loop cutover (DDD-278A / 278B)

## Compatibility release (6A)

- Reads checkpoint schema **0/1/2**, writes **2 only**.
- Interrupt-capable node name **`booking__tools`** must remain until paused HITL volume is zero.
- Before deploy: back up `CHECKPOINT_DB_PATH`.
- Rollback: previous application binary + pre-cutover DB. No in-place schema-2 downgrade.

### Scanner

Use `classifyUpgradeForScan` / `emptyBookingCheckpointScanCounts` for non-PII outcome tallies:

- `already_current`, `upgrade`, `prefetch_required`, `slot_revalidation`, `expired_hitl`, `recovered_partial`, `rejected`

### Resume policy

Legacy `confirm_booking` interrupts resume via expired-confirmation recovery (`recoverExpiredConfirmBookingHitl`): preserve facts, clear frozen command, mark slot unverified, ask the patient to confirm again on a new v2 interrupt. Never silent-approve.

## Post-window cleanup (6B) — gated

**Do not merge** while production can present schema 0/1 rows or paused pre-v2 interrupts.

When old-checkpoint volume is zero (or offline migration completed):

1. Remove deprecated booking state channel readers and interrupt aliases.
2. Optional rename `bookingDraft` → `bookingSession`.
3. Remove compatibility-only tests and leftover prompt workflow rules.
4. Update `AGENT.md` for the final topology.
