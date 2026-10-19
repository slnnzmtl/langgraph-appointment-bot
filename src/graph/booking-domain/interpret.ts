import type {
  UnderstoodBookingTurn,
  ControlIntent,
  ScheduleIntent,
  ServiceIntent,
} from "./turn.js";

const PHONE_RE = /(?:\+?380|0)\d{9}\b/;
const ISO_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;

const CONTROL_ALIASES: Array<{ intent: ControlIntent; patterns: RegExp[] }> = [
  {
    intent: { kind: "main_menu" },
    patterns: [/головне меню/i, /\bmain menu\b/i, /^меню$/i],
  },
  {
    intent: { kind: "abandon" },
    patterns: [/^скасувати$/i, /^cancel$/i, /^ні,? дякую$/i, /^no,? thanks$/i],
  },
  {
    intent: { kind: "human_handoff" },
    patterns: [/оператор/i, /адміністратор/i, /\bhuman\b/i, /live agent/i],
  },
  {
    intent: { kind: "hitl_yes" },
    patterns: [/^✅$/, /^так$/i, /^yes$/i, /^confirm$/i],
  },
  {
    intent: { kind: "hitl_no" },
    patterns: [/^❌$/, /^ні$/i, /^no$/i, /^decline$/i],
  },
  {
    intent: { kind: "return_to_booking" },
    patterns: [/повернутися до запису/i, /return to booking/i],
  },
  {
    intent: { kind: "visit_status" },
    patterns: [/мій запис/i, /my (visit|booking|appointment)/i],
  },
];

const SKIP_NOTE_RE = /^(пропустити|продовжити без коментаря|skip|no note)$/i;
const NAME_RE = /^[\p{L}'’\-\s]{2,40}$/u;
const FAQ_SIDE_RE = /(графік|адрес|цін|price|hours|address|how much|скільки коштує)/i;
const BOOKING_VERB_RE = /(запис|book|appointment|reschedule|перенес)/i;

export type InterpretChoice = {
  id: string;
  label: string;
  aliases?: string[];
};

export type InterpretBookingTurnInput = {
  rawText: string;
  /** Current choice ids/labels from the projected view (ordinals resolve only here). */
  choices?: InterpretChoice[];
  /** When true, treat free text as a visit note candidate. */
  awaitingNote?: boolean;
  /** When set, treat free text as the named contact field. */
  awaitingContactField?: "firstName" | "lastName";
  /** Pending service confirmation is open. */
  awaitingServiceConfirm?: boolean;
};

const normalize = (value: string): string => value.trim().toLocaleLowerCase("uk");

const matchChoice = (
  text: string,
  choices: InterpretChoice[],
): InterpretChoice | null => {
  const exactId = choices.find((c) => c.id === text);
  if (exactId) {
    return exactId;
  }
  const normalized = normalize(text);
  const byLabel = choices.find((c) => {
    if (normalize(c.label) === normalized) {
      return true;
    }
    return c.aliases?.some((alias) => normalize(alias) === normalized) === true;
  });
  if (byLabel) {
    return byLabel;
  }
  const ordinal = Number.parseInt(text, 10);
  if (
    Number.isInteger(ordinal)
    && ordinal >= 1
    && ordinal <= choices.length
    && String(ordinal) === text
  ) {
    return choices[ordinal - 1] ?? null;
  }
  return null;
};

const serviceIntentFromChoice = (choice: InterpretChoice): ServiceIntent | undefined => {
  if (choice.id === "confirm_service" || choice.id === "confirm") {
    return { kind: "confirm_pending_service" };
  }
  if (choice.id === "decline_service" || choice.id === "choose_other") {
    return { kind: "decline_pending_service" };
  }
  if (choice.id.startsWith("svc:") || choice.id.startsWith("svc-")) {
    return {
      kind: "named_procedure",
      query: choice.label,
      serviceId: choice.id.replace(/^svc:/, ""),
    };
  }
  return undefined;
};

const extractPhones = (text: string): string | undefined => {
  const phone = text.match(PHONE_RE)?.[0];
  if (phone == null) {
    return undefined;
  }
  return phone.startsWith("+")
    ? phone
    : phone.startsWith("0")
      ? `+38${phone}`
      : `+${phone}`;
};

const extractDates = (text: string): string[] =>
  [...text.matchAll(ISO_DATE_RE)].map((match) => match[1]!).filter(Boolean);

const extractTimes = (text: string): string[] =>
  [...text.matchAll(TIME_RE)].map((match) => {
    const hours = match[1]!.padStart(2, "0");
    const minutes = match[2]!;
    return `${hours}:${minutes}`;
  });

/**
 * Deterministic turn interpreter.
 * Covers control, choices/ordinals, phones, dates/times, note skip, name fields,
 * service confirm/decline, and FAQ side questions. Ambiguous dual times fail closed.
 */
export const interpretBookingTurnDeterministic = (
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  const text = input.rawText.trim();
  if (text.length === 0) {
    return {};
  }

  // Service confirm precedes generic HITL yes/no aliases.
  if (input.awaitingServiceConfirm) {
    if (/^(так|yes|✅|confirm)$/i.test(text)) {
      return { serviceIntent: { kind: "confirm_pending_service" } };
    }
    if (/^(ні|no|❌|інш)/i.test(text)) {
      return { serviceIntent: { kind: "decline_pending_service" } };
    }
  }

  for (const entry of CONTROL_ALIASES) {
    if (entry.patterns.some((re) => re.test(text))) {
      return { controlIntent: entry.intent };
    }
  }

  if (input.choices != null && input.choices.length > 0) {
    const matched = matchChoice(text, input.choices);
    if (matched != null) {
      const schedule = scheduleIntentFromChoice(matched.id);
      if (schedule != null) {
        return { scheduleIntent: schedule, choice: { choiceId: matched.id, label: matched.label } };
      }
      const service = serviceIntentFromChoice(matched);
      if (service != null) {
        return { serviceIntent: service, choice: { choiceId: matched.id, label: matched.label } };
      }
      if (matched.id === "skip_note" || matched.id === "skip") {
        return { note: { kind: "skip" }, choice: { choiceId: matched.id, label: matched.label } };
      }
      return { choice: { choiceId: matched.id, label: matched.label } };
    }
  }

  if (input.awaitingNote && SKIP_NOTE_RE.test(text)) {
    return { note: { kind: "skip" } };
  }
  if (input.awaitingNote && text.length > 0 && extractPhones(text) == null) {
    // Free text while note is open is a note answer unless it is clearly FAQ-only.
    if (FAQ_SIDE_RE.test(text) && !BOOKING_VERB_RE.test(text)) {
      return { informationalQuestion: text };
    }
    return { note: { kind: "answer", value: text } };
  }

  if (
    input.awaitingContactField != null
    && NAME_RE.test(text)
    && extractPhones(text) == null
    && extractDates(text).length === 0
  ) {
    return {
      contactFacts: {
        [input.awaitingContactField]: text.trim(),
      },
    };
  }

  const patch: UnderstoodBookingTurn = {};
  const phone = extractPhones(text);
  if (phone) {
    patch.contactFacts = { phoneNumber: phone };
  }

  const dates = extractDates(text);
  const times = extractTimes(text);
  // Fail closed on dual conflicting schedule facts.
  if (dates.length > 1 || times.length > 1) {
    return {
      ...patch,
      // Leave schedule unset — caller/kernel asks for clarification.
    };
  }

  const date = dates[0];
  const time = times[0];
  if (date && time) {
    patch.scheduleIntent = { kind: "date_and_time", date, time };
  } else if (date) {
    patch.scheduleIntent = { kind: "date", date };
  } else if (time) {
    patch.scheduleIntent = { kind: "time", time };
  }

  if (SKIP_NOTE_RE.test(text) && patch.scheduleIntent == null && patch.contactFacts == null) {
    patch.note = { kind: "skip" };
  }

  // Side-question heuristic: hours/address/price without booking verbs.
  // Keep as informational even when DATE/TIME is open — do not abandon booking.
  if (FAQ_SIDE_RE.test(text) && !BOOKING_VERB_RE.test(text)) {
    patch.informationalQuestion = text;
  }

  return patch;
};

/** Apply choice onto schedule when the choice id encodes a date/time snapshot entry. */
export const scheduleIntentFromChoice = (
  choiceId: string,
): ScheduleIntent | undefined => {
  if (choiceId.startsWith("date:")) {
    return { kind: "date", date: choiceId.slice("date:".length) };
  }
  if (choiceId.startsWith("time:")) {
    return { kind: "time", time: choiceId.slice("time:".length) };
  }
  return undefined;
};

/**
 * Optional structured LLM fallback. Implementations live outside booking-domain
 * (must stay LangChain-free). On failure the caller preserves the session.
 */
export type StructuredBookingTurnInterpreter = (
  input: InterpretBookingTurnInput & {
    deterministic: UnderstoodBookingTurn;
  },
) => Promise<UnderstoodBookingTurn | null>;

/**
 * Deterministic first; optional structured LLM fills gaps for note/name/service.
 * LLM failure → return deterministic only (caller must not mutate on empty).
 */
export const interpretBookingTurn = async (
  input: InterpretBookingTurnInput,
  structured?: StructuredBookingTurnInterpreter,
): Promise<UnderstoodBookingTurn> => {
  const deterministic = interpretBookingTurnDeterministic(input);
  if (structured == null) {
    return deterministic;
  }
  const hasUsefulDeterministic =
    deterministic.controlIntent != null
    || deterministic.choice != null
    || deterministic.scheduleIntent != null
    || deterministic.contactFacts != null
    || deterministic.note != null
    || deterministic.serviceIntent != null
    || deterministic.informationalQuestion != null;
  // Still allow LLM to enrich multi-fact turns that only captured a phone.
  if (
    hasUsefulDeterministic
    && deterministic.controlIntent != null
  ) {
    return deterministic;
  }
  try {
    const fromLlm = await structured({ ...input, deterministic });
    if (fromLlm == null) {
      return deterministic;
    }
    return {
      ...deterministic,
      ...fromLlm,
      // Control from deterministic wins.
      ...(deterministic.controlIntent != null
        ? { controlIntent: deterministic.controlIntent }
        : {}),
    };
  } catch {
    return deterministic;
  }
};
