import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Command, Overwrite } from "@langchain/langgraph";
import { expect } from "vitest";

import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import type { BookingDraft } from "../booking-draft.js";
import type { ClinicState } from "../state.js";

export const makeListedMeetings = (): BookingContext => ({
  meetings: [
    {
      id: "m-1",
      name: "Консультація - Daniel",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    },
  ],
  dateFrom: "2026-08-11",
});

export const makeListedContact = (): ContactLookupContext => ({
  contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] }],
});

export const ownedContactContext = (contactId = "contact-1"): ContactLookupContext => ({
  ownership: "telegram",
  contacts: [{
    id: contactId,
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    missingFields: [],
  }],
});

export const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  supervisorIntent: null,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  availabilityCursor: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
  selectedAvailabilityDate: null,
  bookingDraft: null,
  pendingInteraction: null,
  faqSkipLlm: false,
  bookingSchemaVersion: 1,
  bookingDecision: null,
  inboundChoiceId: null,
  ...overrides,
});

export const canonicalBookingDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft => ({
  version: 1,
  mode: "create",
  phase: "details",
  serviceAcceptance: {
    status: "accepted",
    service: {
      id: "svc-1",
      name: "Процедура",
      source: "catalog",
    },
  },
  selectedDate: "2026-09-10",
  selectedSlot: {
    dateStart: "2026-09-10T14:00:00",
    dateEnd: "2026-09-10T14:30:00",
    label: "14:00",
  },
  requestedTime: null,
  note: { status: "skipped" },
  contactId: "contact-1",
  pendingCommand: null,
  replacement: null,
  ...overrides,
});

export const unwrapCommandUpdate = <T extends Record<string, unknown>>(result: unknown): T => {
  if (result instanceof Command) {
    return (result.update ?? {}) as T;
  }
  return result as T;
};

export const agentMessagesOf = (update: { agentMessages?: unknown }): BaseMessage[] => {
  const raw = update.agentMessages;
  if (raw == null) {
    return [];
  }
  if (raw instanceof Overwrite) {
    return (raw as Overwrite<BaseMessage[]>).value;
  }
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    return (raw as Overwrite<BaseMessage[]>).value;
  }
  return Array.isArray(raw) ? raw as BaseMessage[] : [];
};

export const runtimeToolAi = (
  toolCalls: NonNullable<AIMessage["tool_calls"]>,
  content: AIMessage["content"] = "",
): AIMessage =>
  new AIMessage({
    content,
    tool_calls: toolCalls,
    additional_kwargs: { runtimeToolOrigin: "command_prepare" },
  });

export const faqCatalogAi = (
  content: string,
  action: "keep_catalog" | "offer_consultation" | "close_catalog" | "invalid" = "keep_catalog",
): AIMessage => {
  const tag = action === "invalid"
    ? "<faq_catalog_action>do_something_else</faq_catalog_action>"
    : `<faq_catalog_action>${action}</faq_catalog_action>`;
  const body = content.trim().length > 0 ? `${content.trim()}\n${tag}` : tag;
  return new AIMessage(body);
};

export const lastToolCallFromPrepare = (result: unknown) => {
  const update = unwrapCommandUpdate(result);
  const messages = update.agentMessages instanceof Overwrite
    ? (update.agentMessages as Overwrite<AIMessage[]>).value
    : (update.agentMessages as AIMessage[] | undefined);
  const last = messages?.at(-1);
  expect(last).toBeInstanceOf(AIMessage);
  return (last as AIMessage).tool_calls?.[0];
};
