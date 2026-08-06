import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

import type { McpCallTool } from "../composition/clinic-adapters.js";
import { getTelegramUserId } from "./telegram-user-context.js";

export type ReadToolsOptions = {
  callTool: McpCallTool;
};

export type BookingToolsOptions = {
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

const toToolResult = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

export const createReadTools = (options: ReadToolsOptions): StructuredToolInterface[] => {
  const { callTool } = options;

  const listServices = tool(
    async (input: { limit?: number }) => {
      try {
        const result = await callTool("search_entity", {
          entityType: "cService",
          limit: input.limit ?? 50,
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "list_services",
      description: "List clinic services (cService) from EspoCRM: names, pricing, duration.",
      schema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe("Max services to return"),
      }),
    },
  );

  const getService = tool(
    async (input: { serviceId: string }) => {
      try {
        const result = await callTool("get_entity", {
          entityType: "cService",
          entityId: input.serviceId,
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "get_service",
      description: "Get a single clinic service by id from EspoCRM.",
      schema: z.object({
        serviceId: z.string().min(1).describe("cService entity id"),
      }),
    },
  );

  return [listServices, getService];
};

export const createBookingTools = (options: BookingToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const findContactByTelegram = tool(
    async (_input: Record<string, never>) => {
      try {
        const cTelegram = getTelegramUserId();
        const result = await callTool("search_contacts", { cTelegram, limit: 5 });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "find_contact_by_telegram",
      description:
        "Find EspoCRM contact linked to the current Telegram user id (cTelegram). Uses the injected telegram id, not a model-supplied value.",
      schema: z.object({}),
    },
  );

  const findContactByPhone = tool(
    async (input: { phoneNumber: string }) => {
      try {
        const result = await callTool("search_contacts", {
          phoneNumber: input.phoneNumber,
          limit: 5,
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "find_contact_by_phone",
      description: "Find EspoCRM contact by phone number.",
      schema: z.object({
        phoneNumber: z.string().min(1).describe("Patient phone number"),
      }),
    },
  );

  const createContact = tool(
    async (input: { firstName: string; lastName?: string; phoneNumber?: string }) => {
      try {
        const cTelegram = getTelegramUserId();
        const result = await callTool("create_contact", {
          firstName: input.firstName,
          ...(input.lastName ? { lastName: input.lastName } : {}),
          ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
          cTelegram,
          skipDuplicateCheck: true,
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "create_contact",
      description:
        "Create a new EspoCRM contact. cTelegram is set from the injected Telegram user id.",
      schema: z.object({
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    },
  );

  const linkTelegramToContact = tool(
    async (input: { contactId: string }) => {
      try {
        const cTelegram = getTelegramUserId();
        const result = await callTool("update_entity", {
          entityType: "Contact",
          entityId: input.contactId,
          data: { cTelegram },
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "link_telegram_to_contact",
      description:
        "Backfill or overwrite Contact.cTelegram with the current Telegram user id after a phone match.",
      schema: z.object({
        contactId: z.string().min(1).describe("EspoCRM Contact id"),
      }),
    },
  );

  const createMeeting = tool(
    async (input: {
      name: string;
      dateStart: string;
      dateEnd: string;
      contactId: string;
      serviceId?: string;
      description?: string;
      location?: string;
    }) => {
      const draft = {
        name: input.name,
        dateStart: input.dateStart,
        dateEnd: input.dateEnd,
        contactId: input.contactId,
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
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
          dateStart: input.dateStart,
          dateEnd: input.dateEnd,
          assignedUserId,
          parentType: "Contact",
          parentId: input.contactId,
          contactsIds: [input.contactId],
          ...(input.serviceId ? { cServicesIds: [input.serviceId] } : {}),
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
        "Book an appointment in EspoCRM. Pauses for human confirmation before writing. Injects assignedUserId and Contact parent fields.",
      schema: z.object({
        name: z.string().min(1).describe("Meeting title"),
        dateStart: z.string().describe("Start datetime in Kyiv local ISO format"),
        dateEnd: z.string().describe("End datetime in Kyiv local ISO format"),
        contactId: z.string().min(1).describe("Patient Contact id"),
        serviceId: z.string().optional().describe("cService id to link"),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
    },
  );

  return [
    findContactByTelegram,
    findContactByPhone,
    createContact,
    linkTelegramToContact,
    createMeeting,
  ];
};
