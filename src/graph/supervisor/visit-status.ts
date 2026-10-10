import { trackEvent } from "../../analytics/track.js";
import { defaultMenuLabels } from "../../shared/clinic-constants.js";
import { labelIdFor } from "../../shared/message-content.js";
import { attachPrefetchVisits } from "../context-blocks.js";
import {
  openVisitActionMenuInteraction,
  reduceBookingSession,
  type VisitSelectMeeting,
} from "../booking-session.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking-interaction-render.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { supervisorFinishReply } from "./visit-select.js";

/** Exact main-menu tap for «Мій запис» / My visit. */
export const isVisitStatusMenuLabel = (text: string): boolean =>
  labelIdFor(text) === "mainMyVisit";

/**
 * Pre-LLM visit-status signal: menu taps plus appointment assertions/disputes
 * that must force a CRM refetch before any model sees them. Softer “what visits
 * do I have?” paraphrases are classified by the supervisor `intent` field.
 */
export const isVisitStatusSignal = (line: string): boolean => {
  const trimmed = line.trim();
  if (isVisitStatusMenuLabel(trimmed)) {
    return true;
  }
  return /(?:^|\s)(?:у\s+мене\s+(?:вже\s+|уже\s+)?є\s+запис|(?:я\s+)?(?:вже|уже)\s+запис[\p{L}]*|already\s+booked|booked\s+(?:an?\s+)?appointment|i\s+already\s+booked)(?:\s|$|[?!.,])/iu
    .test(trimmed);
};

export const visitSelectMeetingsFromContext = (
  bookingContext: ClinicState["bookingContext"],
): VisitSelectMeeting[] =>
  (bookingContext?.meetings ?? []).map((meeting): VisitSelectMeeting => ({
    id: meeting.id,
    ...(meeting.name != null ? { name: meeting.name } : {}),
    ...(meeting.dateStart != null ? { dateStart: meeting.dateStart } : {}),
    ...(meeting.dateEnd != null ? { dateEnd: meeting.dateEnd } : {}),
  }));

export const buildVisitStatusMenuUpdate = (
  prefetchUpdate: ClinicStateUpdate,
  state: ClinicState,
  bookingContext: ClinicState["bookingContext"],
): ClinicStateUpdate => {
  const replyText = attachPrefetchVisits("", bookingContext, "visit_ask");
  const meetings = visitSelectMeetingsFromContext(bookingContext);
  const hasVisit = meetings.length > 0;
  trackEvent("visit_status_response", {
    source: bookingContext == null
      ? "prefetch_unavailable"
      : hasVisit
        ? "crm_list"
        : "crm_empty",
  });
  if (!hasVisit) {
    return supervisorFinishReply(
      prefetchUpdate,
      replyText,
      [...defaultMenuLabels(false)],
      null,
    );
  }
  const visitInteraction = openVisitActionMenuInteraction(meetings);
  const session = reduceBookingSession(
    {
      bookingDraft: state.bookingDraft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "visit_menu_opened", interaction: visitInteraction },
  );
  const combinedText = replyText.trim()
    || String(renderBookingInteractionMessage(visitInteraction).content);
  return supervisorFinishReply(
    prefetchUpdate,
    combinedText,
    replyButtonsForInteraction(visitInteraction),
    session.pendingInteraction,
  );
};
