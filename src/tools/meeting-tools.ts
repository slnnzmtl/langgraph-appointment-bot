import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

import { CLINIC_SLOT_MINUTES } from "../shared/clinic-constants.js";
import type { McpCallTool } from "../shared/mcp.js";
import {
  computeFreeSlots,
  extractMeetingsFromSearchResult,
  normalizeLocalIsoDatetime,
} from "./availability-slots.js";
import { toToolResult } from "./tool-result.js";

export type MeetingToolsOptions = {
  callTool: McpCallTool;
  assignedUserId: string;
};

/** Phase 4 Telegram Yes/No callbacks resume with this shape (LangGraph skips falsy `resume`). */
export type BookingConfirmResume = { confirmed: boolean };

export const isBookingConfirmed = (decision: unknown): boolean =>
  typeof decision === "object"
  && decision !== null
  && "confirmed" in decision
  && (decision as BookingConfirmResume).confirmed === true;

export const createMeetingTools = (options: MeetingToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const presentAvailabilitySlots = tool(
    async (input: { date: string; durationMinutes?: number }) => {
      try {
        const stepMinutes = input.durationMinutes ?? CLINIC_SLOT_MINUTES;
        const raw = await callTool("search_meetings", {
          dateFrom: input.date,
          dateTo: input.date,
          assignedUserId,
          limit: 100,
        });
        const meetings = extractMeetingsFromSearchResult(raw);
        const slots = computeFreeSlots({
          day: input.date,
          meetings,
          stepMinutes,
        });
        return JSON.stringify({ slots, date: input.date, stepMinutes });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message, slots: [] });
      }
    },
    {
      name: "present_availability_slots",
      description:
        "Compute free appointment slots for a calendar day from CRM meetings (search_meetings). Returns JSON { slots: [{ id, label, dateStart, dateEnd }, ...] }. List the slot labels in your reply and ask the user to type one — do not invent times.",
      schema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar day YYYY-MM-DD"),
        durationMinutes: z
          .number()
          .int()
          .min(15)
          .max(180)
          .optional()
          .describe("Slot length in minutes (default 30)"),
      }),
    },
  );

  const createMeeting = tool(
    async (input: {
      name: string;
      dateStart: string;
      dateEnd: string;
      contactId: string;
      confirmMessage: string;
      serviceId: string;
      description?: string;
      location?: string;
    }) => {
      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft = {
        name: input.name,
        dateStart,
        dateEnd,
        contactId: input.contactId,
        confirmMessage: input.confirmMessage.trim(),
        serviceId: input.serviceId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
      };

      const decision = interrupt({ type: "confirm_booking", draft });
      if (!isBookingConfirmed(decision)) {
        return JSON.stringify({ cancelled: true, message: "Booking cancelled by user." });
      }

      try {
        const result = await callTool("create_meeting", {
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
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "create_meeting",
      description:
        "Book an appointment when contact, service, and start/end are known. Call immediately. Requires confirmMessage (patient language). Pauses for Yes/No before writing; injects assignedUserId and Contact parent fields.",
      schema: z.object({
        name: z.string().min(1).describe("Meeting title in the patient's chat language"),
        dateStart: z.string().describe("Start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("End datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        contactId: z.string().min(1).describe("Patient Contact id"),
        confirmMessage: z
          .string()
          .min(1)
          .describe(
            "Short Yes/No question in the patient's chat language (e.g. Підтвердити запис?). Ignore supervisor prompt language.",
          ),
        serviceId: z.string().min(1).describe("Required cService entity id (resolve via list_services)"),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
    },
  );

  return [presentAvailabilitySlots, createMeeting];
};
