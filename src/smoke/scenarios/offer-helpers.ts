import {
  BOOKING_OFFER_MENU,
  BOOKING_REPLACE_MENU,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_NO_VISITS,
  SERVICE_CANDIDATE_OTHER_LABEL_UK,
} from "../../shared/clinic-constants.js";
import { matchingCatalogRows } from "../../graph/catalog-match.js";
import { faqHighlightedService } from "../../graph/faq-highlight.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { normalizeReplyLabel } from "../../shared/message-content.js";
import type { McpCallTool } from "../../shared/mcp.js";
import {
  SERVICES_CONTEXT_MAX_ROWS,
  type ServicesContext,
} from "../../tools/service-tools.js";
import { expectNotCalled, SmokeAssertError } from "../assert.js";
import type { SmokeSession, TurnResult } from "../harness.js";

const WRITE_TOOLS = [
  "create_meeting",
  "update_meeting",
  "create_contact",
  "cancel_meeting",
  "reschedule_meeting",
] as const;

type Pending = TurnResult["state"]["pendingInteraction"];

const isRootCatalogPending = (
  pending: Pending,
): pending is Extract<NonNullable<Pending>, { kind: "service_candidate" }> =>
  pending?.kind === "service_candidate"
  && (pending.owner === "faq" || pending.owner === "booking");

const BOOK_LABEL = DEFAULT_MENU_NO_VISITS[0];

const requestExplicitBook = async (
  session: SmokeSession,
  turn: TurnResult,
): Promise<TurnResult> =>
  turn.buttons.includes(BOOK_LABEL)
    ? session.tap(BOOK_LABEL)
    : session.say(BOOK_LABEL);

export const isConsultationName = (name: string): boolean =>
  /консультац/i.test(name.trim());

export type NamedProcedurePick = {
  id: string;
  name: string;
  /** Free-text token for «запиши на {token}» that uniquely matches this row. */
  token: string;
  durationMinutes?: number;
};

const STEM_MIN_LEN = 5;

/** Candidate utterance tokens from a CRM service name (longest first). */
const candidateTokensForName = (name: string): string[] => {
  const normalized = normalizeReplyLabel(name);
  const words = normalized.split(/[\s,/()]+/u).filter((part) => part.length >= STEM_MIN_LEN);
  const tokens = new Set<string>();
  for (const word of words) {
    tokens.add(word);
    for (let len = word.length; len >= STEM_MIN_LEN; len -= 1) {
      tokens.add(word.slice(0, len));
    }
  }
  return [...tokens].sort((left, right) => right.length - left.length);
};

/**
 * Pick a non-consultation catalog row with a free-text token that
 * {@link matchingCatalogRows} resolves uniquely. Prefers /колаген/i names.
 */
export const pickUniqueNamedProcedure = (
  services: ServicesContext["list"],
  label: string,
): NamedProcedurePick => {
  const catalog = services.slice(0, SERVICES_CONTEXT_MAX_ROWS);
  const nonConsult = catalog.filter(
    (row) => row.id !== CONSULTATION_SERVICE_ID && !isConsultationName(row.name),
  );
  if (nonConsult.length === 0) {
    throw new SmokeAssertError(
      `${label}: no non-consultation services in catalog (${catalog.length} rows)`,
    );
  }
  const ordered = [
    ...nonConsult.filter((row) => /колаген/i.test(row.name)),
    ...nonConsult.filter((row) => !/колаген/i.test(row.name)),
  ];
  for (const row of ordered) {
    for (const token of candidateTokensForName(row.name)) {
      const matches = matchingCatalogRows(token, catalog);
      if (matches.length === 1 && matches[0]!.id === row.id) {
        return {
          id: row.id,
          name: row.name,
          token,
          ...(row.duration != null && Number.isFinite(row.duration)
            ? { durationMinutes: row.duration }
            : {}),
        };
      }
    }
  }
  throw new SmokeAssertError(
    `${label}: no unique matchingCatalogRows token among ${nonConsult.length} non-consultation services`,
  );
};

/** CRM titles in the botulinum family (Latin brand rows the LLM selector adds). */
const BOTULINUM_FAMILY_LABEL = "ботулінотерап";

export type FamilyFreeTextPick = {
  text: "ботокс";
  familyIds: string[];
};

/**
 * Live family for free-text «ботокс» smoke coverage. Requires ≥2
 * {@link matchingCatalogRows} hits (includes «Корекція ботокс» / «Мезоботокс»).
 * Allowlist also unions botulinum CRM titles so brand chips the family
 * selector expands to (Botox/Disport) are not rejected as non-family.
 */
export const pickFamilyFreeText = (
  services: ServicesContext["list"],
  label: string,
): FamilyFreeTextPick => {
  const lexical = matchingCatalogRows("ботокс", services);
  if (lexical.length < 2) {
    throw new SmokeAssertError(
      `${label}: matchingCatalogRows(«ботокс») need ≥2 rows, got ${lexical.length}`,
    );
  }
  const familyIds = [
    ...new Set([
      ...lexical.map((row) => row.id),
      ...services
        .filter((row) => normalizeReplyLabel(row.name).includes(BOTULINUM_FAMILY_LABEL))
        .map((row) => row.id),
    ]),
  ];
  return { text: "ботокс", familyIds };
};

/** Root catalog opened after a no-service replacement cancel (FAQ or booking-owned). */
export const assertFaqRootCatalog = (label: string, turn: TurnResult): void => {
  const pending = turn.state.pendingInteraction;
  if (!isRootCatalogPending(pending)) {
    throw new SmokeAssertError(
      `${label}: expected faq|booking service_candidate, got ${pending?.kind ?? "null"}`,
    );
  }
  // FAQ-owned root after choose-other still marks consultation declined.
  if (pending.owner === "faq" && pending.consultationDeclined !== true) {
    throw new SmokeAssertError(
      `${label}: FAQ root catalog must set consultationDeclined`,
    );
  }
  if (pending.choices.length === 0) {
    throw new SmokeAssertError(`${label}: root catalog has no choices`);
  }
  if (turn.buttons.includes(BOOKING_OFFER_MENU[0])) {
    throw new SmokeAssertError(
      `${label}: root catalog opened a consultation/service offer`,
    );
  }
};

/** service_confirm for one CRM row after a deterministic catalog token. */
export const assertServiceOffer = (
  label: string,
  turn: TurnResult,
  serviceId: string,
): void => {
  const pending = turn.state.pendingInteraction;
  if (pending?.kind !== "service_confirm" || pending.service.id !== serviceId) {
    throw new SmokeAssertError(
      `${label}: expected service_confirm ${serviceId}, got ${pending?.kind ?? "null"}/${pending?.kind === "service_confirm" ? pending.service.id : "n/a"}`,
    );
  }
};

/**
 * After a no-service cancel, submit the scenario's unique procedure token
 * and require that service offer. When the FAQ model opens family chips via
 * `open_catalog` instead of a single offer, drill to the unique row.
 */
export const selectUniqueProcedureAfterRootCatalog = async (
  session: SmokeSession,
  label: string,
  procedure: NamedProcedurePick,
  cancelTurn: TurnResult,
): Promise<TurnResult> => {
  // REPLACE after accepting a pending offer continues into DATE/TIME. Browse
  // away to a root catalog before the unique procedure token.
  let catalogTurn = cancelTurn;
  for (let i = 0; i < 4; i += 1) {
    if (isRootCatalogPending(catalogTurn.state.pendingInteraction)) {
      break;
    }
    if (hasBookingOfferKeyboard(catalogTurn.buttons)) {
      catalogTurn = await session.tap(BOOKING_OFFER_MENU[1]);
      continue;
    }
    // DATE/TIME or other post-cancel waits — leave booking via services guide.
    catalogTurn = await session.say("Послуги");
  }
  assertFaqRootCatalog(label, catalogTurn);
  let turn = await session.say(procedure.token);
  for (let i = 0; i < 6; i += 1) {
    const pending = turn.state.pendingInteraction;
    if (pending?.kind === "service_confirm" && pending.service.id === procedure.id) {
      return turn;
    }
    if (faqHighlightedService(pending) != null) {
      turn = await requestExplicitBook(session, turn);
      continue;
    }
    if (isRootCatalogPending(pending)) {
      const exact = pending.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && (choice.serviceIds?.length === 1 && choice.serviceIds[0] === procedure.id)
          && turn.buttons.includes(choice.label),
      );
      const containing = pending.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && choice.serviceIds?.includes(procedure.id) === true
          && turn.buttons.includes(choice.label),
      );
      const pick = exact ?? containing;
      if (pick != null) {
        turn = await session.tap(pick.label);
        continue;
      }
      // Exact CRM title often collapses open_catalog to service_confirm.
      turn = await session.say(procedure.name);
      continue;
    }
    break;
  }
  assertServiceOffer(label, turn, procedure.id);
  return turn;
};

/** Assert a turn opened narrowed FAQ family chips (not root, not Так/Обрати). */
export const expectFamilyCatalogTurn = (
  label: string,
  turn: TurnResult,
  options: {
    familyIds: readonly string[];
    rootChoiceIds?: readonly string[];
  },
): void => {
  const pending = turn.state.pendingInteraction;
  // Family selector may collapse slang to one CRM row — still a valid catalog hit.
  if (pending?.kind === "service_confirm") {
    const familySet = new Set(options.familyIds);
    if (!familySet.has(pending.service.id)) {
      throw new SmokeAssertError(
        `${label}: service_confirm ${pending.service.id} (${pending.service.name ?? "?"}) not in family`,
      );
    }
    if (turn.buttons.includes(BOOKING_OFFER_MENU[0]) === false) {
      throw new SmokeAssertError(
        `${label}: unique family offer missing «${BOOKING_OFFER_MENU[0]}»`,
      );
    }
    if (turn.state.bookingDraft?.serviceAcceptance?.status === "accepted") {
      throw new SmokeAssertError(
        `${label}: must not auto-accept serviceAcceptance`,
      );
    }
    expectNotCalled(label, turn.calls, [...WRITE_TOOLS]);
    return;
  }
  if (!isRootCatalogPending(pending)) {
    throw new SmokeAssertError(
      `${label}: expected faq|booking service_candidate, got ${pending?.kind ?? "null"}`,
    );
  }
  if (pending.choices.length < 2) {
    throw new SmokeAssertError(
      `${label}: expected ≥2 family choices, got ${pending.choices.length}`,
    );
  }
  const familySet = new Set(options.familyIds);
  for (const choice of pending.choices) {
    for (const id of choice.serviceIds ?? []) {
      if (!familySet.has(id)) {
        throw new SmokeAssertError(
          `${label}: choice «${choice.label}» includes non-family id ${id}`,
        );
      }
    }
    if (!turn.buttons.includes(choice.label)) {
      throw new SmokeAssertError(
        `${label}: button missing for choice «${choice.label}» (buttons=[${turn.buttons.join(" | ")}])`,
      );
    }
  }
  if (options.rootChoiceIds != null) {
    const rootSet = new Set(options.rootChoiceIds);
    const sameAsRoot =
      pending.choices.length === options.rootChoiceIds.length
      && pending.choices.every((choice) => rootSet.has(choice.id));
    if (sameAsRoot) {
      throw new SmokeAssertError(
        `${label}: choices still match root catalog ids [${options.rootChoiceIds.join(",")}]`,
      );
    }
  }
  if (turn.buttons.includes(BOOKING_OFFER_MENU[0])) {
    throw new SmokeAssertError(
      `${label}: unexpected «${BOOKING_OFFER_MENU[0]}» on family catalog keyboard`,
    );
  }
  // Brand-level guide (Botox/Disport or Nabota), not only «Корекція ботокс» / «Мезоботокс».
  const brandNeedles = ["disport", "nabota"];
  const hasBrandChip = turn.buttons.some((button) => {
    const normalized = normalizeReplyLabel(button);
    return brandNeedles.some((needle) => normalized.includes(needle));
  });
  if (!hasBrandChip) {
    throw new SmokeAssertError(
      `${label}: expected a Disport/Nabota brand chip, got [${turn.buttons.join(" | ")}]`,
    );
  }
  if (turn.state.bookingDraft?.serviceAcceptance != null) {
    throw new SmokeAssertError(
      `${label}: must not guess serviceAcceptance (${turn.state.bookingDraft.serviceAcceptance.service.id})`,
    );
  }
  expectNotCalled(label, turn.calls, [...WRITE_TOOLS]);
};

/** Load cService rows the same way list_services does (for smoke procedure picks). */
export const loadCatalogServiceRows = async (
  callTool: McpCallTool,
  label: string,
): Promise<ServicesContext["list"]> => {
  const raw = await callTool("search_entity", {
    entityType: "cService",
    select: ["id", "name", "duration", "description"],
    limit: 200,
  });
  const record = asJsonRecord(raw);
  const list = Array.isArray(record?.list) ? record.list : Array.isArray(raw) ? raw : [];
  const rows: ServicesContext["list"] = [];
  for (const entry of list) {
    const row = asJsonRecord(entry);
    if (row == null || typeof row.id !== "string" || typeof row.name !== "string") {
      continue;
    }
    rows.push({
      id: row.id,
      name: row.name,
      ...(row.duration !== undefined && row.duration !== null
        ? { duration: Number(row.duration) }
        : {}),
    });
  }
  if (rows.length === 0) {
    throw new SmokeAssertError(`${label}: search_entity(cService) returned no rows`);
  }
  return rows;
};

const hasBookingOfferKeyboard = (buttons: string[]): boolean =>
  buttons.includes(BOOKING_OFFER_MENU[0]) && buttons.includes(BOOKING_OFFER_MENU[1]);

const hasReplaceKeyboard = (buttons: string[]): boolean =>
  buttons.includes(BOOKING_REPLACE_MENU[0]) && buttons.includes(BOOKING_REPLACE_MENU[1]);

/** Drive until the consultation / procedure BOOKING OFFER keyboard is visible. */
export const openBookingOffer = async (
  session: SmokeSession,
  label: string,
  maxTurns = 4,
): Promise<TurnResult> => {
  let turn = await session.say("Записатись");
  for (let i = 0; i < maxTurns; i += 1) {
    if (hasBookingOfferKeyboard(turn.buttons)) {
      return turn;
    }
    if (i === maxTurns - 1) {
      break;
    }
    turn = await session.say("Записатись на консультацію");
  }
  throw new SmokeAssertError(
    `${label}: never opened BOOKING OFFER keyboard (buttons=[${turn.buttons.join(" | ") || "none"}])`,
  );
};

/** Drive until REPLACE chips (catalog/offer may precede the date-gate). */
export const openReplaceOffer = async (
  session: SmokeSession,
  label: string,
  maxTurns = 6,
): Promise<TurnResult> => {
  let turn = await session.say("Записатись");
  for (let i = 0; i < maxTurns; i += 1) {
    if (hasReplaceKeyboard(turn.buttons)) {
      return turn;
    }
    if (hasBookingOfferKeyboard(turn.buttons)) {
      turn = turn.buttons.includes(BOOKING_OFFER_MENU[0])
        ? await session.tap(BOOKING_OFFER_MENU[0])
        : await session.say(BOOKING_OFFER_MENU[0]);
      continue;
    }
    if (turn.state.pendingInteraction?.kind === "service_candidate") {
      turn = await session.say("Записатись на консультацію");
      continue;
    }
    if (i === maxTurns - 1) {
      break;
    }
    turn = await session.say("Записатись на консультацію");
  }
  throw new SmokeAssertError(
    `${label}: never opened REPLACE keyboard (buttons=[${turn.buttons.join(" | ") || "none"}] pending=${turn.state.pendingInteraction?.kind ?? "null"})`,
  );
};

/**
 * Open «Послуги» with a visit already on file (not «Записатись» — that opens
 * REPLACE before any service is chosen). Accepts consultation BOOKING OFFER or
 * an FAQ catalog; declines a premature REPLACE and retries.
 */
export const openServicesEntryWithVisit = async (
  session: SmokeSession,
  label: string,
  maxTurns = 6,
): Promise<TurnResult> => {
  let turn = await session.say("Послуги");
  for (let i = 0; i < maxTurns; i += 1) {
    if (hasReplaceKeyboard(turn.buttons)) {
      await session.tap(BOOKING_REPLACE_MENU[1]);
      turn = await session.say("Послуги");
      continue;
    }
    if (hasBookingOfferKeyboard(turn.buttons)) {
      return turn;
    }
    if (turn.state.pendingInteraction?.kind === "service_candidate") {
      return turn;
    }
    if (i === maxTurns - 1) {
      break;
    }
    turn = await session.say("Послуги");
  }
  throw new SmokeAssertError(
    `${label}: expected BOOKING OFFER or FAQ catalog after Послуги, got [${turn.buttons.join(" | ") || "none"}] pending=${turn.state.pendingInteraction?.kind ?? "null"}`,
  );
};

/** Drill FAQ catalog until a non-consultation service_confirm is open. */
export const drillToProcedureOffer = async (
  session: SmokeSession,
  label: string,
  maxTaps = 8,
  /** When set, resume from this turn (catalog or offer) instead of tapping «Обрати іншу». */
  start?: TurnResult,
): Promise<TurnResult> => {
  let turn: TurnResult;
  if (start != null) {
    turn = hasBookingOfferKeyboard(start.buttons)
      ? await session.tap(BOOKING_OFFER_MENU[1])
      : start;
  } else {
    turn = await session.tap(BOOKING_OFFER_MENU[1]);
  }
  for (let i = 0; i < maxTaps; i += 1) {
    const interaction = turn.state.pendingInteraction;
    if (interaction?.kind === "service_confirm") {
      if (!isConsultationName(interaction.service.name ?? "")) {
        return turn;
      }
      // Consultation confirm mid-drill — choose other again.
      if (turn.buttons.includes(BOOKING_OFFER_MENU[1])) {
        turn = await session.tap(BOOKING_OFFER_MENU[1]);
        continue;
      }
    }
    if (interaction?.kind === "service_candidate") {
      // Unique remaining CRM id stays FAQ-owned until an explicit book request.
      const highlighted = faqHighlightedService(interaction);
      if (
        highlighted != null
        && !isConsultationName(highlighted.serviceName ?? interaction.choices[0]?.label ?? "")
      ) {
        turn = await requestExplicitBook(session, turn);
        continue;
      }
      if (turn.buttons.includes(SERVICE_CANDIDATE_OTHER_LABEL_UK) && i === maxTaps - 1) {
        turn = await session.tap(SERVICE_CANDIDATE_OTHER_LABEL_UK);
        continue;
      }
      const next = interaction.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && !isConsultationName(choice.label)
          && turn.buttons.includes(choice.label),
      );
      const fallback = interaction.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && turn.buttons.includes(choice.label),
      );
      const pick = next ?? fallback;
      if (pick) {
        turn = await session.tap(pick.label);
        continue;
      }
    }
    break;
  }
  throw new SmokeAssertError(
    `${label}: never reached non-consultation service_confirm (pending=${turn.state.pendingInteraction?.kind ?? "null"})`,
  );
};
