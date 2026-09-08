/** Clinic slot step and fallback open hours when CRM working time is unavailable. */
export const CLINIC_SLOT_TZ = "Europe/Kyiv";

const fromEnv = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

/** Env keys required when `NODE_ENV=production` (host `.env` overlay; demo defaults stay in git). */
export const PRODUCTION_CLINIC_ENV_KEYS = [
  "CLINIC_ADDRESS",
  "CLINIC_MAPS_URL",
  "CONSULTATION_SERVICE_ID",
  "CLINIC_NAME_UK",
  "CLINIC_NAME_EN",
  "CLINIC_WELCOME_VENUE_UK",
  "CLINIC_DOCTOR_REF_UK",
] as const;

/** Demo placeholders — override via env for a real deployment. */
export const CLINIC_ADDRESS = fromEnv("CLINIC_ADDRESS", "вул. Прикладна 1, м. Київ");
export const CLINIC_MAPS_URL = fromEnv(
  "CLINIC_MAPS_URL",
  "https://www.google.com/maps?q=Kyiv,+Ukraine",
);
export const CLINIC_MAPS_MARKDOWN = `[Google maps](${CLINIC_MAPS_URL})`;
/** CRM `cService` id of «Консультація» — set via env in a real deployment. */
export const CONSULTATION_SERVICE_ID = fromEnv(
  "CONSULTATION_SERVICE_ID",
  "demo-consultation-service-id",
);
/** Supervisor greeting clinic identity (Ukrainian). */
export const CLINIC_NAME_UK = fromEnv(
  "CLINIC_NAME_UK",
  "демонстраційна клініка косметичної медицини",
);
/** Supervisor greeting clinic identity (English). */
export const CLINIC_NAME_EN = fromEnv("CLINIC_NAME_EN", "a demo cosmetic medicine clinic");
/** Welcome “візит до …” venue phrase (Ukrainian). */
export const CLINIC_WELCOME_VENUE_UK = fromEnv(
  "CLINIC_WELCOME_VENUE_UK",
  "демонстраційного косметологічного кабінету",
);
/** Welcome “консультацію до …” doctor reference (Ukrainian). */
export const CLINIC_DOCTOR_REF_UK = fromEnv("CLINIC_DOCTOR_REF_UK", "лікаря");

/** Patient-facing copy for internal failures (routing, model, or step-limit errors). */
export const PATIENT_FALLBACK_MESSAGE =
  "Вибачте, зараз не вдалося обробити запит 🙏 Спробуйте, будь ласка, ще раз за хвилинку.";
export const CLINIC_OPEN_HOUR = 9;
export const CLINIC_CLOSE_HOUR = 18;
export const CLINIC_SLOT_MINUTES = 30;
export const MAX_PRESENTED_SLOTS = 12;
/** Max calendar days to scan when looking for the next free appointment day. */
export const MAX_AVAILABILITY_SEARCH_DAYS = 30;
/** How many open days with free slots to return in one next-available search. */
export const MAX_PROPOSED_AVAILABILITY_DAYS = 3;

/** Always appended last on every reply keyboard (back to idle DEFAULT MENU). */
export const MAIN_MENU_LABEL = "Головне меню";
/** DATE-step extra shortcut; TIME step may include it too. */
export const OTHER_DATE_LABEL = "Інша дата";
export const OTHER_DATE_LABEL_EN = "Another date";

export const DEFAULT_MENU_NO_VISITS = ["Записатись", "Послуги", "Адреса"] as const;
export const DEFAULT_MENU_HAS_VISITS = ["Мій запис", "Послуги", "Адреса"] as const;

/** Ukrainian DEFAULT MENU labels from whether the patient has upcoming visits. */
export const defaultMenuLabels = (hasVisit: boolean): readonly string[] =>
  hasVisit ? DEFAULT_MENU_HAS_VISITS : DEFAULT_MENU_NO_VISITS;

/** XML tag names for dynamic LLM context blocks (formatters + tool reuse hints). */
export const CONTEXT_TAGS = {
  contact: "contact_info",
  /** One tag; projections differ per agent (flag vs full meetings). */
  meetings: "list_planned_meetings",
  availability: "availability",
  selectedSlot: "selected_slot",
  services: "list_services",
} as const;

/** Visit-change shortcuts after listing upcoming visits (supervisor «Мій запис»). */
export const VISIT_CHANGE_MENU = ["Перенести", "Скасувати", "Ні, дякую"] as const;
export const VISIT_CHANGE_MENU_EN = ["Reschedule", "Cancel", "No, thanks"] as const;

/**
 * When a new booking is blocked by an existing Planned or Confirmed visit — cancel then book
 * the new slot. Never includes «Перенести» (reschedule is only after «Мій запис»).
 * Cancel label matches VISIT_CHANGE «Скасувати»; context (conflict copy) distinguishes intent.
 */
export const BOOKING_REPLACE_MENU = ["Скасувати", "Ні, дякую"] as const;
export const BOOKING_REPLACE_MENU_EN = ["Cancel", "No, thanks"] as const;

/** Yes/no shortcuts for consultation or book-this-procedure offers (FAQ + booking STEP SERVICE). */
export const BOOKING_OFFER_MENU = ["Так", "Обрати іншу процедуру"] as const;
export const BOOKING_OFFER_MENU_EN = ["Yes", "Choose another procedure"] as const;

/** Code-owned INTENT skip while bookingNoteStatus is awaiting (DDD-48). */
export const INTENT_SKIP_LABEL = "Продовжити без коментаря";
export const INTENT_SKIP_LABEL_EN = "Continue with no comments";

/** Patient-facing note question when create_meeting is blocked before INTENT (DDD-49/51). */
export const BOOKING_NOTE_QUESTION_UK =
  "Чи можете поділитися деталями перед записом — що вас турбує або яку процедуру маєте на увазі? Якщо ні — запишу без коментаря.";

/**
 * Labels the supervisor must route itself — never sticky-continue into booking.
 * Includes DEFAULT MENU items, main menu, the consultation-decline browse path,
 * and soft declines after a move/cancel or replace offer.
 */
export const SUPERVISOR_OWNED_REPLY_LABELS = new Set<string>([
  MAIN_MENU_LABEL,
  ...DEFAULT_MENU_NO_VISITS,
  ...DEFAULT_MENU_HAS_VISITS,
  "Book",
  "Services",
  "Address",
  "My visit",
  "Обрати іншу процедуру",
  "Choose another procedure",
  VISIT_CHANGE_MENU[2],
  VISIT_CHANGE_MENU_EN[2],
]);
