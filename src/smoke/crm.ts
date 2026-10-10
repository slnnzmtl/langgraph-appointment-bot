import { asJsonRecord } from "../shared/json-record.js";
import type { McpCallTool } from "../shared/mcp.js";
import { kyivToday } from "../tools/availability-slots.js";
import { lookupPlannedMeetings } from "../tools/planned-meetings.js";
import { entityIdFromResult } from "./cleanup.js";
import {
  isIsolatedSmokeTelegramId,
  isSmokeTesterName,
  SMOKE_CONTACT_NAME,
  uniqueSmokePhone,
} from "./env.js";

export type SmokeContact = {
  id: string;
  cTelegram?: string;
  firstName?: string;
  lastName?: string;
};

const listFromSearch = (raw: unknown): Record<string, unknown>[] => {
  const record = asJsonRecord(raw);
  if (!record) {
    if (Array.isArray(raw)) {
      return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    }
    return [];
  }
  const list = record.contacts ?? record.list ?? record.meetings;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
};

export const findContactByTelegram = async (
  callTool: McpCallTool,
  telegramId: string,
): Promise<SmokeContact | null> => {
  const search = await callTool("search_contacts", {
    cTelegram: telegramId,
    limit: 5,
  });
  const first = listFromSearch(search)[0];
  if (!first || typeof first.id !== "string") {
    return null;
  }
  return {
    id: first.id,
    ...(typeof first.cTelegram === "string" ? { cTelegram: first.cTelegram } : {}),
    ...(typeof first.firstName === "string" ? { firstName: first.firstName } : {}),
    ...(typeof first.lastName === "string" ? { lastName: first.lastName } : {}),
  };
};

const loadContactNames = async (
  callTool: McpCallTool,
  contact: SmokeContact,
): Promise<SmokeContact> => {
  if (contact.firstName != null && contact.lastName != null) {
    return contact;
  }
  const raw = await callTool("get_entity", {
    entityType: "Contact",
    entityId: contact.id,
  });
  const record = asJsonRecord(raw);
  return {
    ...contact,
    ...(typeof record?.firstName === "string" ? { firstName: record.firstName } : {}),
    ...(typeof record?.lastName === "string" ? { lastName: record.lastName } : {}),
    ...(typeof record?.cTelegram === "string" ? { cTelegram: record.cTelegram } : {}),
  };
};

export const assertSmokeTesterContact = (contact: SmokeContact, label: string): void => {
  if (!isSmokeTesterName(contact.firstName, contact.lastName)) {
    throw new Error(
      `${label}: refusing to mutate Contact ${contact.id} (expected ${SMOKE_CONTACT_NAME.firstName} ${SMOKE_CONTACT_NAME.lastName}, got ${String(contact.firstName)} ${String(contact.lastName)})`,
    );
  }
};

export const ensureSmokeContact = async (
  callTool: McpCallTool,
  telegramId: string,
  options: { firstName?: string; lastName?: string; phoneNumber?: string } = {},
): Promise<SmokeContact> => {
  if (!isIsolatedSmokeTelegramId(telegramId)) {
    throw new Error(
      `ensureSmokeContact: refusing telegram id ${telegramId} (write smoke ids must start with 9998)`,
    );
  }
  const existing = await findContactByTelegram(callTool, telegramId);
  if (existing) {
    const named = await loadContactNames(callTool, existing);
    assertSmokeTesterContact(named, "ensureSmokeContact");
    return named;
  }
  const created = await callTool("create_contact", {
    firstName: options.firstName ?? SMOKE_CONTACT_NAME.firstName,
    lastName: options.lastName ?? SMOKE_CONTACT_NAME.lastName,
    cTelegram: telegramId,
    ...(options.phoneNumber ? { phoneNumber: options.phoneNumber } : {}),
    skipDuplicateCheck: true,
  });
  const id = entityIdFromResult(created);
  if (!id) {
    throw new Error(`ensureSmokeContact: create_contact returned no id for ${telegramId}`);
  }
  return { id, cTelegram: telegramId };
};

/** Soft-cancel all upcoming Planned/Confirmed meetings for a contact (pre-clean). */
export const cancelUpcomingMeetingsForContact = async (
  callTool: McpCallTool,
  contactId: string,
): Promise<string[]> => {
  const planned = await lookupPlannedMeetings(callTool, contactId, kyivToday());
  const cancelled: string[] = [];
  for (const meeting of planned?.meetings ?? []) {
    try {
      await callTool("update_meeting", {
        meetingId: meeting.id,
        status: "Not Held",
      });
      cancelled.push(meeting.id);
    } catch (error: unknown) {
      console.warn(
        `⚠ Pre-clean: failed to cancel meeting ${meeting.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return cancelled;
};

export const preCleanTelegramContact = async (
  callTool: McpCallTool,
  telegramId: string,
): Promise<void> => {
  if (!isIsolatedSmokeTelegramId(telegramId)) {
    throw new Error(
      `preCleanTelegramContact: refusing non-smoke telegram id ${telegramId}`,
    );
  }
  const contact = await findContactByTelegram(callTool, telegramId);
  if (!contact) {
    return;
  }
  const named = await loadContactNames(callTool, contact);
  assertSmokeTesterContact(named, "preCleanTelegramContact");
  await cancelUpcomingMeetingsForContact(callTool, named.id);
};

/** Retry until search_contacts by phone is empty so we do not occupy a real patient number. */
export const allocateUnusedSmokePhone = async (
  callTool: McpCallTool,
  attempts = 16,
): Promise<string> => {
  for (let i = 0; i < attempts; i += 1) {
    const phone = uniqueSmokePhone();
    const search = await callTool("search_contacts", { phoneNumber: phone, limit: 1 });
    const hits = listFromSearch(search);
    if (hits.length === 0) {
      return phone;
    }
  }
  throw new Error("allocateUnusedSmokePhone: could not find an unused E.164 after retries");
};

export const getMeeting = async (
  callTool: McpCallTool,
  meetingId: string,
): Promise<Record<string, unknown>> => {
  const raw = await callTool("get_entity", {
    entityType: "Meeting",
    entityId: meetingId,
  });
  const record = asJsonRecord(raw);
  if (!record) {
    throw new Error(`getMeeting: empty result for ${meetingId}`);
  }
  return record;
};

export const listPlannedMeetingIds = async (
  callTool: McpCallTool,
  contactId: string,
): Promise<string[]> => {
  const planned = await lookupPlannedMeetings(callTool, contactId, kyivToday());
  return (planned?.meetings ?? []).map((meeting) => meeting.id);
};

export const extractMeetingIdFromCreateCalls = (
  calls: Array<{ name: string; result?: unknown }>,
): string | null => {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call?.name !== "create_meeting") {
      continue;
    }
    const record = asJsonRecord(call.result);
    if (typeof record?.id === "string" && record.id) {
      return record.id;
    }
    if (typeof record?.meetingId === "string" && record.meetingId) {
      return record.meetingId;
    }
    if (typeof call.result === "string") {
      const match = /ID:\s*(\S+)/i.exec(call.result);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return null;
};
