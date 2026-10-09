import { SERVICE_CANDIDATE_OTHER_LABEL_UK } from "../shared/clinic-constants.js";
import type { InteractionChoice } from "./booking-session.js";
import type { ServicesContext } from "../tools/service-tools.js";

const MAX_FAQ_CATALOG_CHOICES = 8;
/** Safe width for Telegram 2-column reply keyboard labels. */
const MAX_FAQ_CHIP_LABEL_LENGTH = 36;
const FAQ_CATALOG_CLOSE_UK = "Який варіант вам підходить?";
const FAQ_CATALOG_EMPTY_UK = "Оберіть, будь ласка, послугу зі списку.";
const FAQ_CATALOG_INTRO_FALLBACK_UK = "Доступні такі варіанти:";

const lastSeparatorIndex = (value: string): number =>
  Math.max(
    value.lastIndexOf(" "),
    value.lastIndexOf(","),
    value.lastIndexOf("—"),
    value.lastIndexOf("–"),
    value.lastIndexOf("-"),
  );

/** Longest shared prefix of `names`, snapped back to a word boundary. */
const longestCommonPrefix = (names: readonly string[]): string => {
  if (names.length === 0) {
    return "";
  }
  let prefix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    const name = names[i]!;
    let end = 0;
    const limit = Math.min(prefix.length, name.length);
    while (end < limit && prefix[end] === name[end]) {
      end += 1;
    }
    prefix = prefix.slice(0, end);
    if (prefix.length === 0) {
      return "";
    }
  }
  const boundary = lastSeparatorIndex(prefix);
  if (boundary > 0 && boundary < prefix.length - 1) {
    return prefix.slice(0, boundary + 1);
  }
  if (boundary === prefix.length - 1) {
    return prefix;
  }
  const lastSep = lastSeparatorIndex(prefix);
  return lastSep >= 0 ? prefix.slice(0, lastSep + 1) : "";
};

/**
 * Longest word-boundary prefix shared by at least two labels.
 * Survives outliers like a short «FULL FACE» chip among full CRM titles.
 */
const sharedPathPrefix = (names: readonly string[]): string => {
  if (names.length < 2) {
    return "";
  }
  const all = longestCommonPrefix(names);
  if (all.length > 0) {
    return all;
  }
  let best = "";
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const pair = longestCommonPrefix([names[i]!, names[j]!]);
      if (pair.length > best.length) {
        best = pair;
      }
    }
  }
  return best;
};

const stripLeadingSeparators = (value: string): string =>
  value.replace(/^[\s,.—–-]+/u, "").trim();

/** Suffix after a shared prefix, or the full name when the suffix would be empty. */
const shortFaqTextLabel = (name: string, sharedPrefix: string): string => {
  if (sharedPrefix.length === 0 || !name.startsWith(sharedPrefix)) {
    return name.trim();
  }
  const suffix = stripLeadingSeparators(name.slice(sharedPrefix.length));
  return suffix.length > 0 ? suffix : name.trim();
};

const truncateLabel = (label: string, maxLength: number): string => {
  if (label.length <= maxLength) {
    return label;
  }
  if (maxLength <= 1) {
    return "…";
  }
  return `${label.slice(0, maxLength - 1).trimEnd()}…`;
};

/** Cap length and disambiguate collisions after truncation (chips only). */
const ensureUniqueChipLabels = (
  labels: readonly string[],
  maxLength: number = MAX_FAQ_CHIP_LABEL_LENGTH,
): string[] => {
  const used = new Map<string, number>();
  return labels.map((raw) => {
    const base = truncateLabel(raw.trim(), maxLength);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    if (count === 0) {
      return base;
    }
    const suffix = ` (${count + 1})`;
    const room = Math.max(1, maxLength - suffix.length);
    return `${truncateLabel(raw.trim(), room)}${suffix}`;
  });
};

const sourceTextLabel = (choice: InteractionChoice): string =>
  (choice.displayLabel ?? choice.label).trim();

const normalizeLabelKey = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * Strip a shared path only when the patient already chose that path
 * (selected chip appears inside the shared prefix).
 */
const shouldStripSharedPrefix = (
  sharedPrefix: string,
  selectedLabel: string | undefined,
): boolean => {
  if (sharedPrefix.length === 0) {
    return false;
  }
  const selected = normalizeLabelKey(selectedLabel ?? "");
  if (selected.length === 0) {
    return false;
  }
  return normalizeLabelKey(sharedPrefix).includes(selected);
};

export type ShortenFaqChoiceLabelsOptions = {
  /** Chip the patient just tapped; required before a family prefix may be stripped. */
  selectedLabel?: string;
};

/**
 * Shorten FAQ choice labels: optionally strip a shared/selected path from text
 * options, keep those untruncated as {@link InteractionChoice.displayLabel},
 * and cap {@link InteractionChoice.label} for Telegram chips only.
 */
export const shortenFaqChoiceLabels = (
  choices: readonly InteractionChoice[],
  options?: ShortenFaqChoiceLabelsOptions,
): InteractionChoice[] => {
  if (choices.length === 0) {
    return [];
  }
  if (choices.length === 1) {
    const choice = choices[0]!;
    const text = sourceTextLabel(choice);
    const chip = truncateLabel(text, MAX_FAQ_CHIP_LABEL_LENGTH);
    return [{
      id: choice.id,
      label: chip,
      ...(chip !== text ? { displayLabel: text } : {}),
      ...(choice.serviceIds != null ? { serviceIds: choice.serviceIds } : {}),
    }];
  }
  const names = choices.map(sourceTextLabel);
  const sharedPrefix = sharedPathPrefix(names);
  const stripPrefix = shouldStripSharedPrefix(sharedPrefix, options?.selectedLabel)
    ? sharedPrefix
    : "";
  const textLabels = names.map((name) => shortFaqTextLabel(name, stripPrefix));
  const chipLabels = ensureUniqueChipLabels(textLabels);
  return choices.map((choice, index) => {
    const text = textLabels[index]!;
    const chip = chipLabels[index]!;
    return {
      id: choice.id,
      label: chip,
      ...(chip !== text ? { displayLabel: text } : {}),
      ...(choice.serviceIds != null ? { serviceIds: choice.serviceIds } : {}),
    };
  });
};

/** Prefer full text label for message bullets; fall back to chip label. */
export const faqChoiceTextLabel = (choice: InteractionChoice): string =>
  sourceTextLabel(choice);

const FAQ_LIST_LINE = /^\s*(?:[•*\-]|\d+[.)])\s/m;

/**
 * Keep a short model explanation ahead of deterministic catalog bullets.
 * Drops list lines and trailing question paragraphs so chips/close stay graph-owned.
 */
export const faqCatalogIntroFromModel = (text: string): string => {
  const beforeList = text.split(FAQ_LIST_LINE)[0] ?? "";
  const paragraphs = beforeList
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.endsWith("?"));
  return paragraphs.slice(0, 2).join("\n\n").trim();
};

/**
 * Deterministic FAQ catalog body from structured choices. Optional model intro
 * is kept; empty intro falls back to a short graph-owned line. Singleton CRM
 * rows may include their description under the bullet.
 */
export const renderFaqCatalogReply = (
  choices: readonly InteractionChoice[],
  services: ServicesContext["list"] = [],
  modelIntro: string = "",
): string => {
  if (choices.length === 0) {
    return FAQ_CATALOG_EMPTY_UK;
  }
  const byId = new Map(services.map((row) => [row.id, row]));
  const lines = choices.flatMap((choice) => {
    const label = faqChoiceTextLabel(choice);
    if (label.length === 0) {
      return [];
    }
    const bullet = `• ${label}`;
    const serviceIds = choice.serviceIds ?? [];
    if (serviceIds.length !== 1) {
      return [bullet];
    }
    const description = byId.get(serviceIds[0]!)?.description?.trim();
    if (description == null || description.length === 0) {
      return [bullet];
    }
    return [bullet, description];
  });
  if (lines.length === 0) {
    return FAQ_CATALOG_EMPTY_UK;
  }
  const intro = modelIntro.trim().length > 0
    ? modelIntro.trim()
    : FAQ_CATALOG_INTRO_FALLBACK_UK;
  return `${intro}\n\n${lines.join("\n")}\n\n${FAQ_CATALOG_CLOSE_UK}`;
};

/**
 * Deterministic fallback when the LLM partitioner is unavailable or empty.
 * Returns raw CRM labels — caller runs {@link shortenFaqChoiceLabels} once.
 */
export const buildFaqCatalogChoices = (
  services: ServicesContext["list"],
  remainingIds?: readonly string[],
): InteractionChoice[] => {
  const rows = remainingIds != null && remainingIds.length > 0
    ? services.filter((row) => remainingIds.includes(row.id))
    : services;
  if (rows.length === 0) {
    return [];
  }
  if (rows.length === 1) {
    const row = rows[0]!;
    return [{
      id: row.id,
      label: row.name.trim(),
      serviceIds: [row.id],
    }];
  }

  if (rows.length <= MAX_FAQ_CATALOG_CHOICES) {
    return rows.map((row) => ({
      id: row.id,
      label: row.name.trim(),
      serviceIds: [row.id],
    }));
  }

  // Keep seven CRM chips + one overflow group so every id stays reachable.
  const visible = rows.slice(0, MAX_FAQ_CATALOG_CHOICES - 1);
  const overflow = rows.slice(MAX_FAQ_CATALOG_CHOICES - 1);
  return [
    ...visible.map((row) => ({
      id: row.id,
      label: row.name.trim(),
      serviceIds: [row.id],
    })),
    {
      id: "faq_other",
      label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
      serviceIds: overflow.map((row) => row.id),
    },
  ];
};
