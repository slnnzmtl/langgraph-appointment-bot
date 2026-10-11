import {
  BOOKING_OFFER_MENU,
  CONSULTATION_SERVICE_ID,
  SERVICE_CANDIDATE_OTHER_LABEL_UK,
} from "../../shared/clinic-constants.js";
import { matchingCatalogRows } from "../../graph/agent-loop/shared.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { normalizeReplyLabel } from "../../shared/message-content.js";
import type { McpCallTool } from "../../shared/mcp.js";
import {
  SERVICES_CONTEXT_MAX_ROWS,
  type ServicesContext,
} from "../../tools/service-tools.js";
import { SmokeAssertError } from "../assert.js";
import type { SmokeSession, TurnResult } from "../harness.js";

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

/** Drill FAQ catalog until a non-consultation service_confirm is open. */
export const drillToProcedureOffer = async (
  session: SmokeSession,
  label: string,
  maxTaps = 8,
): Promise<TurnResult> => {
  let turn = await session.tap(BOOKING_OFFER_MENU[1]);
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
