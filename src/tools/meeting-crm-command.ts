/**
 * CRM write payloads frozen on mutation HITL (create / reschedule / cancel).
 * Shared by meeting tools (interrupt draft) and the booking kernel (frozenCommand).
 */

import { normalizeLocalIsoDatetime } from "./availability-slots.js";

export type CreateMeetingCrmInput = {
  name: string;
  dateStart: string;
  dateEnd: string;
  contactId: string;
  serviceId: string;
  assignedUserId: string;
  description?: string;
  location?: string;
};

/** Exact object passed to MCP create_meeting / stored on confirm_booking interrupt. */
export const buildCreateMeetingCrmPayload = (
  input: CreateMeetingCrmInput,
): Record<string, unknown> => {
  const dateStart = normalizeLocalIsoDatetime(input.dateStart);
  const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
  return {
    name: input.name,
    dateStart,
    dateEnd,
    assignedUserId: input.assignedUserId,
    parentType: "Contact",
    parentId: input.contactId,
    contactsIds: [input.contactId],
    cServicesIds: [input.serviceId],
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    status: "Planned",
  };
};

export type RescheduleMeetingCrmInput = {
  meetingId: string;
  dateStart: string;
  dateEnd: string;
};

/** Exact object passed to MCP update_meeting for reschedule. */
export const buildRescheduleMeetingCrmPayload = (
  input: RescheduleMeetingCrmInput,
): Record<string, unknown> => ({
  meetingId: input.meetingId,
  dateStart: normalizeLocalIsoDatetime(input.dateStart),
  dateEnd: normalizeLocalIsoDatetime(input.dateEnd),
});

/** Exact object passed to MCP update_meeting for soft-cancel. */
export const buildCancelMeetingCrmPayload = (
  meetingId: string,
): Record<string, unknown> => ({
  meetingId,
  status: "Not Held",
});
