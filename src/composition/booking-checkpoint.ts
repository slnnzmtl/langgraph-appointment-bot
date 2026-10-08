/**
 * Facade for adapter-layer checkpoint migration. Keeps telegram-bot off graph/*.
 */
export type { BookingCheckpointLegacyState } from "../graph/booking-draft.js";
export { upgradeBookingCheckpoint } from "../graph/booking-session.js";
