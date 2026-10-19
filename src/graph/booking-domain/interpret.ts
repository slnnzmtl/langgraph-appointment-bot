import type { UnderstoodBookingTurn, ControlIntent, ScheduleIntent } from "./turn.js";

const PHONE_RE = /(?:\+?380|0)\d{9}\b/;
const ISO_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/;
const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/;

const CONTROL_ALIASES: Array<{ intent: ControlIntent; patterns: RegExp[] }> = [
  {
    intent: { kind: "main_menu" },
    patterns: [/головне меню/i, /\bmain menu\b/i, /\bmenu\b/i],
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

export type InterpretBookingTurnInput = {
  rawText: string;
  /** Current choice ids/labels from the projected view (ordinals resolve only here). */
  choices?: Array<{ id: string; label: string; aliases?: string[] }>;
};

/**
 * Deterministic turn interpreter (Phase 4 foundation).
 * LLM structured extraction is layered later; this covers phones, dates, times,
 * control intents, choice ids/labels/ordinals.
 */
export const interpretBookingTurnDeterministic = (
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  const text = input.rawText.trim();
  if (text.length === 0) {
    return {};
  }

  for (const entry of CONTROL_ALIASES) {
    if (entry.patterns.some((re) => re.test(text))) {
      return { controlIntent: entry.intent };
    }
  }

  if (input.choices != null && input.choices.length > 0) {
    const byId = input.choices.find((c) => c.id === text);
    if (byId) {
      return { choice: { choiceId: byId.id, label: byId.label } };
    }
    const byLabel = input.choices.find((c) => {
      if (c.label === text) return true;
      return c.aliases?.some((alias) => alias === text) === true;
    });
    if (byLabel) {
      return { choice: { choiceId: byLabel.id, label: byLabel.label } };
    }
    const ordinal = Number.parseInt(text, 10);
    if (
      Number.isInteger(ordinal)
      && ordinal >= 1
      && ordinal <= input.choices.length
      && String(ordinal) === text
    ) {
      const choice = input.choices[ordinal - 1]!;
      return { choice: { choiceId: choice.id, label: choice.label } };
    }
  }

  const patch: UnderstoodBookingTurn = {};
  const phone = text.match(PHONE_RE)?.[0];
  if (phone) {
    patch.contactFacts = {
      phoneNumber: phone.startsWith("+") ? phone : phone.startsWith("0") ? `+38${phone}` : `+${phone}`,
    };
  }

  const date = text.match(ISO_DATE_RE)?.[1];
  const timeMatch = text.match(TIME_RE);
  const time = timeMatch
    ? `${timeMatch[1]!.padStart(2, "0")}:${timeMatch[2]}`
    : undefined;

  if (date && time) {
    patch.scheduleIntent = { kind: "date_and_time", date, time };
  } else if (date) {
    patch.scheduleIntent = { kind: "date", date };
  } else if (time) {
    patch.scheduleIntent = { kind: "time", time };
  }

  // Side-question heuristic: hours/address/price without booking verbs.
  if (
    /(графік|адрес|цін|price|hours|address|how much)/i.test(text)
    && !/(запис|book|appointment|reschedule)/i.test(text)
  ) {
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
