import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import type { McpCallTool } from "../shared/mcp.js";
import { getTelegramUserId } from "./telegram-user-context.js";
import { toToolResult } from "./tool-result.js";

export type ContactToolsOptions = {
  callTool: McpCallTool;
};

export const BOOKING_CONTACT_REQUIRED_FIELDS = [
  "firstName",
  "lastName",
  "phoneNumber",
] as const;

export const contactMissingFields = (contact: Record<string, unknown>): string[] =>
  BOOKING_CONTACT_REQUIRED_FIELDS.filter((field) => {
    const value = contact[field];
    return typeof value !== "string" || value.trim() === "";
  });

const contactRowsFromSearch = (record: Record<string, unknown>): unknown[] | undefined => {
  if (Array.isArray(record.contacts)) {
    return record.contacts;
  }
  if (Array.isArray(record.list)) {
    return record.list;
  }
  return undefined;
};

/** Attach missingFields (null/blank firstName, lastName, phoneNumber) on search_contacts rows. */
export const annotateContactSearchResult = (raw: unknown): string => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return toToolResult(raw);
    }
  }
  if (!value || typeof value !== "object") {
    return toToolResult(raw);
  }
  const record = value as Record<string, unknown>;
  const rows = contactRowsFromSearch(record);
  if (!rows) {
    return toToolResult(raw);
  }
  const annotated = rows.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const contact = item as Record<string, unknown>;
    return { ...contact, missingFields: contactMissingFields(contact) };
  });
  const key = Array.isArray(record.contacts) ? "contacts" : "list";
  return JSON.stringify({ ...record, [key]: annotated });
};

/** Shared by find_contact_by_telegram tool and booking prepare prefetch. */
export const lookupContactByTelegram = async (callTool: McpCallTool): Promise<string> => {
  try {
    const cTelegram = getTelegramUserId();
    const result = await callTool("search_contacts", { cTelegram, limit: 5 });
    return annotateContactSearchResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
};

export const createContactTools = (options: ContactToolsOptions): StructuredToolInterface[] => {
  const { callTool } = options;

  const findContactByTelegram = tool(
    async (_input: Record<string, never>) => lookupContactByTelegram(callTool),
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
        return annotateContactSearchResult(result);
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

  const updateContact = tool(
    async (input: {
      contactId: string;
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
    }) => {
      try {
        const result = await callTool("update_entity", {
          entityType: "Contact",
          entityId: input.contactId,
          data: {
            ...(input.firstName ? { firstName: input.firstName } : {}),
            ...(input.lastName ? { lastName: input.lastName } : {}),
            ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
          },
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "update_contact",
      description:
        "Backfill missing firstName, lastName, and/or phoneNumber on an existing EspoCRM contact before booking.",
      schema: z.object({
        contactId: z.string().min(1).describe("EspoCRM Contact id"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    },
  );

  return [
    findContactByTelegram,
    findContactByPhone,
    createContact,
    linkTelegramToContact,
    updateContact,
  ];
};
