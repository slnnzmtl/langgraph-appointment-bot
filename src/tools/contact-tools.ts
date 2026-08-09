import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import type { McpCallTool } from "../shared/mcp.js";
import { getTelegramUserId } from "./telegram-user-context.js";
import { toToolResult } from "./tool-result.js";

export type ContactToolsOptions = {
  callTool: McpCallTool;
};

/** Shared by find_contact_by_telegram tool and booking prepare prefetch. */
export const lookupContactByTelegram = async (callTool: McpCallTool): Promise<string> => {
  try {
    const cTelegram = getTelegramUserId();
    const result = await callTool("search_contacts", { cTelegram, limit: 5 });
    return toToolResult(result);
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

  return [
    findContactByTelegram,
    findContactByPhone,
    createContact,
    linkTelegramToContact,
  ];
};
