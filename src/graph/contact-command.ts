import { normalizeClinicPhone } from "../shared/phone.js";
import { contactMissingFields } from "../tools/contact-tools.js";
import { getTelegramUserId } from "../tools/telegram-user-context.js";
import type { ClinicState } from "./state.js";
import {
  effectiveBookingContactDetails,
  nextMissingContactField,
  type BookingContactDetails,
  type BookingContactField,
  type PhoneLookupEvidence,
} from "./booking-draft.js";
import {
  phoneLookupFailedThisTurn,
  toolRanThisTurn,
} from "./agent-loop/protocol.js";

export type ContactIdentityResolution =
  | { kind: "owned"; contactId: string; contact: Record<string, unknown> }
  | { kind: "phone_candidate"; contacts: Record<string, unknown>[] }
  | { kind: "unresolved" };

/** Resolve identity from explicit lookup provenance; ambiguous legacy context fails closed. */
export const resolveContactIdentity = (
  context: ClinicState["contactContext"],
  expectedContactId?: string | null,
): ContactIdentityResolution => {
  if (!context) {
    return { kind: "unresolved" };
  }
  const contacts = context.contacts.filter(
    (contact) => typeof contact.id === "string" && contact.id.length > 0,
  );
  if (context.ownership === "phone") {
    return contacts.length > 0
      ? { kind: "phone_candidate", contacts }
      : { kind: "unresolved" };
  }
  if (context.ownership !== "telegram") {
    return { kind: "unresolved" };
  }
  const contact = expectedContactId == null
    ? contacts[0]
    : contacts.find((candidate) => candidate.id === expectedContactId);
  return contact && typeof contact.id === "string"
    ? { kind: "owned", contactId: contact.id, contact }
    : { kind: "unresolved" };
};

export const phoneCandidateCanBeLinked = (
  identity: ContactIdentityResolution,
  contactId: string,
): boolean => {
  if (identity.kind !== "phone_candidate") {
    return false;
  }
  const candidate = identity.contacts.find((contact) => contact.id === contactId);
  if (!candidate) {
    return false;
  }
  const linkedTelegram = candidate.cTelegram;
  if (linkedTelegram == null || (typeof linkedTelegram === "string" && linkedTelegram.trim() === "")) {
    return true;
  }
  try {
    return linkedTelegram === getTelegramUserId();
  } catch {
    // Without the runtime identity, fail closed rather than overwrite a link.
    return false;
  }
};

export const phoneCandidateHasLinkableRow = (identity: ContactIdentityResolution): boolean =>
  identity.kind === "phone_candidate"
  && identity.contacts.some(
    (contact) => typeof contact.id === "string" && phoneCandidateCanBeLinked(identity, contact.id),
  );

/** True when create_contact's phone matches a stored phone candidate that cannot be linked. */
export const createContactPhoneMatchesOccupiedCandidate = (
  identity: ContactIdentityResolution,
  rawPhone: unknown,
): boolean => {
  if (identity.kind !== "phone_candidate" || typeof rawPhone !== "string" || rawPhone.trim() === "") {
    return false;
  }
  const wanted = normalizeClinicPhone(rawPhone);
  if (wanted == null) {
    return false;
  }
  return identity.contacts.some((contact) => {
    if (typeof contact.id !== "string" || phoneCandidateCanBeLinked(identity, contact.id)) {
      return false;
    }
    const candidatePhone = typeof contact.phoneNumber === "string"
      ? normalizeClinicPhone(contact.phoneNumber)
      : null;
    return candidatePhone === wanted;
  });
};

export type CompleteContactDetails = {
  phoneNumber: string;
  firstName: string;
  lastName: string;
};

export type ContactPatch = Partial<CompleteContactDetails>;

export type ContactCommand =
  | { action: "lookup"; phoneNumber: string }
  | { action: "link"; contactId: string }
  | { action: "create"; details: CompleteContactDetails }
  | { action: "update"; contactId: string; fields: ContactPatch }
  | { action: "request_field"; field: BookingContactField; occupied?: boolean }
  | { action: "none" };

const completeDetails = (
  details: BookingContactDetails,
): CompleteContactDetails | null => {
  const phoneNumber = details.phoneNumber?.trim() ?? "";
  const firstName = details.firstName?.trim() ?? "";
  const lastName = details.lastName?.trim() ?? "";
  if (!phoneNumber || !firstName || !lastName) {
    return null;
  }
  if (contactMissingFields({ phoneNumber, firstName, lastName }).length > 0) {
    return null;
  }
  return { phoneNumber, firstName, lastName };
};

/** Evidence applies only to the exact accepted phone from this booking draft. */
export const phoneLookupEvidenceMatches = (
  evidence: PhoneLookupEvidence | null | undefined,
  phoneNumber: string,
): boolean =>
  evidence != null
  && evidence.phoneNumber === phoneNumber
  && evidence.phoneNumber.length > 0;

/**
 * Classify a find_contact_by_phone result for runtime ContactCommand decisions.
 * Multiple candidates fail closed as ambiguous even if some are linkable.
 */
export const classifyPhoneLookupResult = (
  contacts: ReadonlyArray<Record<string, unknown>>,
  phoneNumber: string,
): PhoneLookupEvidence => {
  const normalized = normalizeClinicPhone(phoneNumber) ?? phoneNumber;
  const rows = contacts.filter(
    (contact) => typeof contact.id === "string" && contact.id.length > 0,
  );
  const contactIds = rows.map((contact) => String(contact.id));
  if (rows.length === 0) {
    return {
      phoneNumber: normalized,
      result: "none",
      contactIds: [],
    };
  }
  const identity = {
    kind: "phone_candidate" as const,
    contacts: rows,
  };
  const linkable = rows.filter(
    (contact) => phoneCandidateCanBeLinked(identity, String(contact.id)),
  );
  if (rows.length === 1 && linkable.length === 1) {
    return {
      phoneNumber: normalized,
      result: "single_linkable",
      contactIds,
    };
  }
  if (linkable.length === 0) {
    return {
      phoneNumber: normalized,
      result: "occupied",
      contactIds,
    };
  }
  return {
    phoneNumber: normalized,
    result: "ambiguous",
    contactIds,
  };
};

/**
 * Explicit runtime decision for the next contact step. command_prepare maps
 * lookup/link/create/update to tool calls; request_field is owned by
 * prepare/finalize keyboards.
 */
export const resolveContactCommand = (state: ClinicState): ContactCommand => {
  const draft = state.bookingDraft;
  if (draft == null) {
    return { action: "none" };
  }

  const identity = resolveContactIdentity(state.contactContext, draft.contactId);
  const details = effectiveBookingContactDetails({
    crmContact: identity.kind === "owned" ? identity.contact : null,
    contactDetails: draft.contactDetails ?? null,
  });
  const acceptedPhone = details.phoneNumber != null
    ? (normalizeClinicPhone(details.phoneNumber) ?? details.phoneNumber)
    : null;
  const evidence = draft.phoneLookupEvidence;

  if (identity.kind === "owned") {
    const missing = contactMissingFields(identity.contact);
    if (missing.length === 0) {
      return { action: "none" };
    }
    const patch: ContactPatch = {};
    for (const field of missing) {
      if (field === "phoneNumber" || field === "firstName" || field === "lastName") {
        const value = draft.contactDetails?.[field];
        if (typeof value === "string" && value.trim().length > 0) {
          patch[field] = field === "phoneNumber"
            ? (normalizeClinicPhone(value) ?? value.trim())
            : value.trim();
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      return { action: "update", contactId: identity.contactId, fields: patch };
    }
    const next = nextMissingContactField(details);
    if (next != null) {
      return { action: "request_field", field: next };
    }
    return { action: "none" };
  }

  if (acceptedPhone == null) {
    return { action: "request_field", field: "phoneNumber" };
  }

  // Failed lookup is terminal this turn — do not inject lookup again.
  if (phoneLookupFailedThisTurn(state)) {
    return { action: "none" };
  }

  if (!phoneLookupEvidenceMatches(evidence, acceptedPhone)) {
    return { action: "lookup", phoneNumber: acceptedPhone };
  }

  if (evidence!.result === "occupied") {
    return { action: "request_field", field: "phoneNumber", occupied: true };
  }
  if (evidence!.result === "ambiguous") {
    return { action: "request_field", field: "phoneNumber", occupied: true };
  }
  if (evidence!.result === "single_linkable") {
    const contactId = evidence!.contactIds[0];
    if (contactId == null) {
      return { action: "request_field", field: "phoneNumber" };
    }
    if (identity.kind === "phone_candidate") {
      if (!phoneCandidateCanBeLinked(identity, contactId)) {
        return { action: "request_field", field: "phoneNumber", occupied: true };
      }
    }
    return { action: "link", contactId };
  }

  // result === "none": create only with a complete ladder for this exact phone.
  const complete = completeDetails({ ...details, phoneNumber: acceptedPhone });
  if (complete == null) {
    const next = nextMissingContactField({ ...details, phoneNumber: acceptedPhone });
    return next != null
      ? { action: "request_field", field: next }
      : { action: "none" };
  }
  // Revalidate the exact phone this turn before create_contact (stale "none").
  if (!toolRanThisTurn(state.agentMessages ?? [], "find_contact_by_phone")) {
    return { action: "lookup", phoneNumber: acceptedPhone };
  }
  return { action: "create", details: complete };
};

/** True when command_prepare should inject a contact tool this turn. */
export const contactCommandNeedsToolInjection = (command: ContactCommand): boolean =>
  command.action === "lookup"
  || command.action === "link"
  || command.action === "create"
  || command.action === "update";

/**
 * Contact tools run after the note ladder (or on reschedule ready), and whenever
 * a contact tool already ran this turn so the chain can continue without the LLM.
 */
export const contactCommandReadyForInjection = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  if (draft == null) {
    return false;
  }
  const messages = state.agentMessages ?? [];
  const contactToolThisTurn =
    toolRanThisTurn(messages, "find_contact_by_phone")
    || toolRanThisTurn(messages, "create_contact")
    || toolRanThisTurn(messages, "link_telegram_to_contact")
    || toolRanThisTurn(messages, "update_contact");
  if (contactToolThisTurn) {
    return true;
  }
  if (draft.mode === "reschedule") {
    return draft.rescheduleTarget != null;
  }
  return draft.note.status === "skipped" || draft.note.status === "answered";
};
