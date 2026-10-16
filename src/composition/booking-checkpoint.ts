/**
 * Adapter-facing checkpoint migration. Keeps telegram-bot off graph internals.
 */
export type {
  BookingCheckpointLegacyState,
  BookingCheckpointMigrationTelemetry,
  BookingCheckpointUpgradeResult,
} from "../graph/booking-checkpoint-upgrade.js";
export { upgradeBookingDraftCheckpoint } from "../graph/booking-checkpoint-upgrade.js";
export { upgradeBookingCheckpoint } from "../graph/booking-session.js";
