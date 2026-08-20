import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { finishTrackedWrite, toolErrorJson, trackEvent, trackToolError } from "../analytics/track.js";
import { errorMessage } from "../shared/json-record.js";
import type { McpCallTool } from "../shared/mcp.js";
import { clinicPhoneSchema, optionalClinicPhoneSchema } from "../shared/phone.js";
import { getTelegramUserId } from "./telegram-user-context.js";
import { toToolResult } from "./tool-result.js";

const PHONE_NUMBER_DESCRIBE = "Local UA or +international; normalized to E.164.";

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

export type ContactLookupContext = {
  contacts: Array<Record<string, unknown>>;
  error?: string;
};

export const normalizeContactLookupResult = (contactJson: string): ContactLookupContext => {
  let value: unknown;
  try {
    value = JSON.parse(contactJson) as unknown;
  } catch {
    return { contacts: [], error: "Invalid contact lookup JSON" };
  }
  if (!value || typeof value !== "object") {
    return { contacts: [], error: "Invalid contact lookup result" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") {
    return { contacts: [], error: record.error };
  }
  const rows = contactRowsFromSearch(record) ?? [];
  const contacts = rows.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  return { contacts };
};

const trackContactLookup = (
  name: "contact_lookup_telegram" | "contact_lookup_phone",
  tool: string,
  json: string,
  extra?: Record<string, unknown>,
): void => {
  const parsed = normalizeContactLookupResult(json);
  if (parsed.error) {
    trackEvent(name, { outcome: "error", tool, ...extra });
    trackToolError(tool, parsed.error);
    return;
  }
  const contactId = extractContactIdFromSearchResult(json);
  const missing = parsed.contacts[0]?.missingFields;
  trackEvent(name, {
    outcome: contactId ? "success" : "not_found",
    tool,
    ...(contactId ? { contact_id: contactId } : {}),
    ...(Array.isArray(missing) ? { missing_fields: missing } : {}),
    ...extra,
  });
};

export const extractContactIdFromSearchResult = (contactJson: string): string | null => {
  let value: unknown;
  try {
    value = JSON.parse(contactJson) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || "error" in value) {
    return null;
  }
  const rows = contactRowsFromSearch(value as Record<string, unknown>);
  const first = rows?.[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const id = (first as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

export const lookupContactByTelegram = async (callTool: McpCallTool): Promise<string> => {
  try {
    const cTelegram = getTelegramUserId();
    const result = await callTool("search_contacts", { cTelegram, limit: 5 });
    return annotateContactSearchResult(result);
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) });
  }
};

export const createContactTools = (options: ContactToolsOptions): StructuredToolInterface[] => {
  const { callTool } = options;

  const findContactByPhone = tool(
    async (input: { phoneNumber: string }) => {
      try {
        const result = annotateContactSearchResult(
          await callTool("search_contacts", {
            phoneNumber: input.phoneNumber,
            limit: 5,
          }),
        );
        trackContactLookup("contact_lookup_phone", "find_contact_by_phone", result, {
          has_phone: true,
        });
        return result;
      } catch (error) {
        const result = JSON.stringify({ error: errorMessage(error) });
        trackContactLookup("contact_lookup_phone", "find_contact_by_phone", result, {
          has_phone: true,
        });
        return result;
      }
    },
    {
      name: "find_contact_by_phone",
      description: "Find EspoCRM contact by phone number.",
      schema: z.object({
        phoneNumber: clinicPhoneSchema.describe(PHONE_NUMBER_DESCRIBE),
      }),
    },
  );

  const createContact = tool(
    async (input: { firstName: string; lastName?: string; phoneNumber?: string }) => {
      try {
        const cTelegram = getTelegramUserId();
        const result = toToolResult(
          await callTool("create_contact", {
            firstName: input.firstName,
            ...(input.lastName ? { lastName: input.lastName } : {}),
            ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
            cTelegram,
            skipDuplicateCheck: true,
          }),
        );
        return finishTrackedWrite("create_contact", result, (contactId) => {
          trackEvent("contact_created", {
            outcome: "success",
            ...(contactId ? { contact_id: contactId } : {}),
          });
        });
      } catch (error) {
        return toolErrorJson("create_contact", error);
      }
    },
    {
      name: "create_contact",
      description:
        "Create a new EspoCRM contact. cTelegram is set from the injected Telegram user id.",
      schema: z.object({
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        phoneNumber: optionalClinicPhoneSchema.describe(PHONE_NUMBER_DESCRIBE),
      }),
    },
  );

  const linkTelegramToContact = tool(
    async (input: { contactId: string }) => {
      try {
        const cTelegram = getTelegramUserId();
        const result = toToolResult(
          await callTool("update_entity", {
            entityType: "Contact",
            entityId: input.contactId,
            data: { cTelegram },
          }),
        );
        return finishTrackedWrite("link_telegram_to_contact", result, () => {
          trackEvent("contact_telegram_linked", {
            outcome: "success",
            contact_id: input.contactId,
          });
        });
      } catch (error) {
        return toolErrorJson("link_telegram_to_contact", error);
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
        const fieldsUpdated = (
          ["firstName", "lastName", "phoneNumber"] as const
        ).filter((field) =>
          field === "phoneNumber"
            ? Boolean(input.phoneNumber)
            : typeof input[field] === "string" && input[field]!.trim() !== "",
        );
        const result = toToolResult(
          await callTool("update_entity", {
            entityType: "Contact",
            entityId: input.contactId,
            data: {
              ...(input.firstName ? { firstName: input.firstName } : {}),
              ...(input.lastName ? { lastName: input.lastName } : {}),
              ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
            },
          }),
        );
        return finishTrackedWrite("update_contact", result, () => {
          trackEvent("contact_updated", {
            outcome: "success",
            contact_id: input.contactId,
            fields_updated: fieldsUpdated,
          });
        });
      } catch (error) {
        return toolErrorJson("update_contact", error);
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
        phoneNumber: optionalClinicPhoneSchema.describe(PHONE_NUMBER_DESCRIBE),
      }),
    },
  );

  return [
    findContactByPhone,
    createContact,
    linkTelegramToContact,
    updateContact,
  ];
};
