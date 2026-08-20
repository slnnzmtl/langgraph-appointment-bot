import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { finishTrackedWrite, trackEvent, type Tier1EventName } from "../analytics/track.js";
import { asJsonRecord } from "../shared/json-record.js";
import type { McpCallTool } from "../shared/mcp.js";
import { normalizeLocalIsoDatetime } from "./availability-slots.js";
import { createPresentAvailabilitySlotsTool } from "./availability-tools.js";
import {
  contactMissingFields,
  lookupContactByTelegram,
  normalizeContactLookupResult,
} from "./contact-tools.js";
import {
  CONFIRMATION_GIVEN_SCHEMA,
  CONFIRM_MESSAGE_SCHEMA,
  writeAfterChatConfirmOrHitl,
  type ConfirmDraft,
  type ConfirmFingerprint,
} from "./meeting-confirm.js";
import { createListPlannedMeetingsTool, lookupPlannedMeetings } from "./planned-meetings.js";
import { getTelegramUserId } from "./telegram-user-context.js";

export type { BookingContext, ListedMeeting } from "./planned-meetings.js";
export { lookupPlannedMeetings } from "./planned-meetings.js";

export type MeetingToolsOptions = {
  callTool: McpCallTool;
  assignedUserId: string;
};

const skipHitlPending = (record: Record<string, unknown>): boolean =>
  record.cancelled === true || record.awaitingConfirmation === true;

const finishMeetingMutation = (
  toolName: "create_meeting" | "cancel_meeting" | "reschedule_meeting",
  raw: string,
  successEvent: Extract<
    Tier1EventName,
    "meeting_created" | "meeting_cancelled" | "meeting_rescheduled"
  >,
  successProps: Record<string, unknown>,
): string =>
  finishTrackedWrite(
    toolName,
    raw,
    (entityId) => {
      const meetingId =
        typeof successProps.meeting_id === "string" ? successProps.meeting_id : entityId;
      trackEvent(successEvent, {
        outcome: "success",
        ...successProps,
        ...(meetingId ? { meeting_id: meetingId } : {}),
      });
    },
    { skip: skipHitlPending },
  );

const NOT_AUTHORIZED = "Not authorized";

const notAuthorizedJson = (hint: string): string =>
  JSON.stringify({
    error: NOT_AUTHORIZED,
    hint,
  });

const contactIdFromMeeting = (meeting: Record<string, unknown>): string | null => {
  if (meeting.parentType === "Contact" && typeof meeting.parentId === "string" && meeting.parentId.length > 0) {
    return meeting.parentId;
  }
  const contactsIds = meeting.contactsIds;
  if (Array.isArray(contactsIds)) {
    const first = contactsIds.find((id): id is string => typeof id === "string" && id.length > 0);
    return first ?? null;
  }
  return null;
};

const callerOwnsContact = async (
  callTool: McpCallTool,
  contactId: string,
  fetched?: Record<string, unknown>,
): Promise<boolean> => {
  const telegramId = getTelegramUserId();
  if (typeof fetched?.cTelegram === "string" && fetched.cTelegram === telegramId) {
    return true;
  }
  if (fetched == null) {
    try {
      const contact = asJsonRecord(
        await callTool("get_entity", { entityType: "Contact", entityId: contactId }),
      );
      if (typeof contact?.cTelegram === "string" && contact.cTelegram === telegramId) {
        return true;
      }
    } catch {
      // Fall through to Telegram search.
    }
  }
  const lookup = normalizeContactLookupResult(await lookupContactByTelegram(callTool));
  return lookup.contacts.some((row) => row.id === contactId);
};

const requireOwnedContact = async (
  callTool: McpCallTool,
  contactId: string,
  fetched?: Record<string, unknown>,
): Promise<string | null> => {
  if (await callerOwnsContact(callTool, contactId, fetched)) {
    return null;
  }
  return notAuthorizedJson(
    "Use the Contact linked to this Telegram user (find_contact_by_telegram / create_contact / link_telegram_to_contact).",
  );
};

const requireOwnedMeeting = async (
  callTool: McpCallTool,
  meetingId: string,
): Promise<string | null> => {
  let meeting: Record<string, unknown> = {};
  try {
    meeting = asJsonRecord(
      await callTool("get_entity", { entityType: "Meeting", entityId: meetingId }),
    ) ?? {};
  } catch {
    meeting = {};
  }
  const contactId = contactIdFromMeeting(meeting);
  if (!contactId) {
    return notAuthorizedJson("Resolve meetingId via list_planned_meetings for this Telegram user.");
  }
  return requireOwnedContact(callTool, contactId);
};

export const createMeetingTools = (options: MeetingToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const presentAvailabilitySlots = createPresentAvailabilitySlotsTool({ callTool, assignedUserId });
  const listPlannedMeetings = createListPlannedMeetingsTool(callTool, (contactId) =>
    requireOwnedContact(callTool, contactId),
  );

  const createMeeting = tool(
    async (
      input: {
        name: string;
        dateStart: string;
        dateEnd: string;
        contactId: string;
        confirmMessage: string;
        serviceId: string;
        description?: string;
        location?: string;
        confirmationGiven?: boolean;
      },
      config,
    ) => {
      let contact: Record<string, unknown> = {};
      try {
        contact = asJsonRecord(
          await callTool("get_entity", {
            entityType: "Contact",
            entityId: input.contactId,
          }),
        ) ?? {};
      } catch {
        contact = {};
      }
      const denied = await requireOwnedContact(callTool, input.contactId, contact);
      if (denied) {
        return denied;
      }
      const missing = contactMissingFields(contact);
      if (missing.length > 0) {
        trackEvent("contact_incomplete_blocked", {
          contact_id: input.contactId,
          missing_fields: missing,
        });
        return JSON.stringify({
          error: "Contact incomplete",
          missingFields: missing,
          hint: "Ask for these fields, call update_contact, then retry create_meeting.",
        });
      }

      const planned = await lookupPlannedMeetings(callTool, input.contactId);
      if (planned && planned.meetings.length > 0) {
        return JSON.stringify({
          error: "Already booked",
          meetings: planned.meetings,
          hint: "This patient already has a Planned visit. Cancel or reschedule it before booking another.",
        });
      }

      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft = {
        name: input.name,
        dateStart,
        dateEnd,
        confirmMessage: input.confirmMessage.trim(),
      };
      const execute = () =>
        callTool("create_meeting", {
          name: input.name,
          dateStart,
          dateEnd,
          assignedUserId,
          parentType: "Contact",
          parentId: input.contactId,
          contactsIds: [input.contactId],
          cServicesIds: [input.serviceId],
          ...(input.description ? { description: input.description } : {}),
          ...(input.location ? { location: input.location } : {}),
          status: "Planned",
        });

      const writeProps = {
        contact_id: input.contactId,
        service_id: input.serviceId,
        date_start: dateStart,
      };
      const fingerprint: ConfirmFingerprint = {
        action: "create",
        contactId: input.contactId,
        serviceId: input.serviceId,
        dateStart,
        dateEnd,
      };
      return finishMeetingMutation(
        "create_meeting",
        await writeAfterChatConfirmOrHitl(
          input.confirmationGiven,
          fingerprint,
          execute,
          draft,
          {
            action: "create",
            cancelledMessage: "Booking cancelled by user.",
            contactId: input.contactId,
            serviceId: input.serviceId,
          },
          config,
        ),
        "meeting_created",
        writeProps,
      );
    },
    {
      name: "create_meeting",
      description:
        "Book an appointment when contact, service, and start/end are known and the patient has no other Planned visit. Call immediately on clear book intent — never ask Yes/No in chat first. Requires confirmMessage (patient language). Optional description: Ukrainian intent summary for staff. First call pauses for HITL ✅/❌ reply keyboard (contact must belong to this Telegram user). After explicit chat affirmation (not ✅), re-call with the same args and confirmationGiven true — confirmationGiven is ignored unless that card was shown for these arguments. Injects assignedUserId and Contact parent fields.",
      schema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'Meeting title as "[service-name]: [firstName lastName]" (e.g. "Консультація - Daniel Kovalenko")',
          ),
        dateStart: z.string().describe("Start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("End datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        contactId: z.string().min(1).describe("Patient Contact id"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        serviceId: z.string().min(1).describe("Required cService entity id (resolve via list_services)"),
        description: z
          .string()
          .optional()
          .describe(
            "Ukrainian 1–2 sentence intent summary for clinic staff from this chat (concern, area, named procedure). Translate into Ukrainian if needed. Omit when the patient gave no intent. Never invent details; never put this in confirmMessage or the patient chat reply.",
          ),
        location: z.string().optional(),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  const cancelMeeting = tool(
    async (
      input: {
        meetingId: string;
        confirmMessage: string;
        name?: string;
        confirmationGiven?: boolean;
      },
      config,
    ) => {
      const denied = await requireOwnedMeeting(callTool, input.meetingId);
      if (denied) {
        return denied;
      }
      const draft: ConfirmDraft = {
        confirmMessage: input.confirmMessage.trim(),
        ...(input.name ? { name: input.name } : {}),
      };
      const execute = () =>
        callTool("update_meeting", {
          meetingId: input.meetingId,
          status: "Not Held",
        });

      const writeProps = { meeting_id: input.meetingId };
      const fingerprint: ConfirmFingerprint = {
        action: "cancel",
        meetingId: input.meetingId,
      };
      return finishMeetingMutation(
        "cancel_meeting",
        await writeAfterChatConfirmOrHitl(
          input.confirmationGiven,
          fingerprint,
          execute,
          draft,
          {
            action: "cancel",
            cancelledMessage: "Cancellation cancelled by user.",
            meetingId: input.meetingId,
          },
          config,
        ),
        "meeting_cancelled",
        writeProps,
      );
    },
    {
      name: "cancel_meeting",
      description:
        "Soft-cancel an existing Planned meeting (status Not Held). Resolve meetingId via list_planned_meetings first. Meeting must belong to this Telegram user's Contact. Requires confirmMessage (patient language). Call immediately on clear cancel intent (e.g. «Скасувати візит») — never ask Yes/No in chat first. First call pauses for HITL ✅/❌ reply keyboard; after explicit chat affirmation (not ✅), re-call with the same args and confirmationGiven true (ignored unless a matching HITL card was shown).",
      schema: z.object({
        meetingId: z.string().min(1).describe("Meeting id from list_planned_meetings"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        name: z
          .string()
          .optional()
          .describe("Meeting name for the Yes/No caption (from list_planned_meetings)"),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  const rescheduleMeeting = tool(
    async (
      input: {
        meetingId: string;
        dateStart: string;
        dateEnd: string;
        confirmMessage: string;
        name?: string;
        confirmationGiven?: boolean;
      },
      config,
    ) => {
      const denied = await requireOwnedMeeting(callTool, input.meetingId);
      if (denied) {
        return denied;
      }
      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft: ConfirmDraft = {
        confirmMessage: input.confirmMessage.trim(),
        dateStart,
        dateEnd,
        ...(input.name ? { name: input.name } : {}),
      };
      const execute = () =>
        callTool("update_meeting", {
          meetingId: input.meetingId,
          dateStart,
          dateEnd,
        });

      const writeProps = {
        meeting_id: input.meetingId,
        date_start: dateStart,
        date_end: dateEnd,
      };
      const fingerprint: ConfirmFingerprint = {
        action: "reschedule",
        meetingId: input.meetingId,
        dateStart,
        dateEnd,
      };
      return finishMeetingMutation(
        "reschedule_meeting",
        await writeAfterChatConfirmOrHitl(
          input.confirmationGiven,
          fingerprint,
          execute,
          draft,
          {
            action: "reschedule",
            cancelledMessage: "Reschedule cancelled by user.",
            meetingId: input.meetingId,
          },
          config,
        ),
        "meeting_rescheduled",
        writeProps,
      );
    },
    {
      name: "reschedule_meeting",
      description:
        "Move an existing meeting to a new start/end (same meeting id). Resolve meetingId via list_planned_meetings; pick a free slot with present_availability_slots (pass excludeMeetingIds; do not offer the current start). Meeting must belong to this Telegram user's Contact. Requires confirmMessage (patient language). Once the new slot is chosen, call immediately — never ask Yes/No in chat first. First call pauses for HITL ✅/❌ reply keyboard; after explicit chat affirmation (not ✅), re-call with the same args and confirmationGiven true (ignored unless a matching HITL card was shown).",
      schema: z.object({
        meetingId: z.string().min(1).describe("Meeting id from list_planned_meetings"),
        dateStart: z.string().describe("New start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("New end datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        name: z
          .string()
          .optional()
          .describe("Meeting name for the Yes/No caption (from list_planned_meetings)"),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  return [
    presentAvailabilitySlots,
    createMeeting,
    listPlannedMeetings,
    cancelMeeting,
    rescheduleMeeting,
  ];
};
