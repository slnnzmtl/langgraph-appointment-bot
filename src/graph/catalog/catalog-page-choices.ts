/**
 * Sync catalog page building (cap, uniquify ids, chip shorten). No selector,
 * partition, or service-resolution — safe for booking-domain/decide.
 */
import { SERVICE_CANDIDATE_OTHER_LABEL_UK } from "../../shared/clinic-constants.js";
import { normalizeReplyLabel } from "../../shared/message-content.js";
import type { InteractionChoice } from "../booking/booking-session.js";

export const MAX_FAQ_CATALOG_CHOICES = 8;
/** Safe width for Telegram 2-column reply keyboard labels. */
export const MAX_FAQ_CHIP_LABEL_LENGTH = 36;

export type CatalogPageRow = { id: string; name: string };

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

const shortFaqTextLabel = (name: string, sharedPrefix: string): string => {
  if (sharedPrefix.length === 0 || !name.startsWith(sharedPrefix)) {
    return name.trim();
  }
  const suffix = stripLeadingSeparators(name.slice(sharedPrefix.length));
  return suffix.length > 0 ? suffix : name.trim();
};

/**
 * Chip truncation: keep a readable start and the distinctive end
 * (`Ботулінотерапія…FULL FACE+шия`), not a head-only prefix.
 */
const truncateLabel = (label: string, maxLength: number): string => {
  if (label.length <= maxLength) {
    return label;
  }
  const ellipsis = "…";
  if (maxLength <= ellipsis.length) {
    return ellipsis.slice(0, maxLength);
  }
  const budget = maxLength - ellipsis.length;
  if (budget < 2) {
    return `${label.slice(0, budget)}${ellipsis}`;
  }

  const tokenEnd = label.search(/[\s,.—–-]/u);
  const firstToken = tokenEnd > 0 ? label.slice(0, tokenEnd) : "";
  const lockHead = firstToken.length >= 2 && firstToken.length <= budget - 1;
  let head: string;
  if (lockHead) {
    head = firstToken;
  } else {
    const headLen = Math.min(Math.ceil(budget / 2), budget - 1);
    const raw = label.slice(0, headLen);
    const sep = lastSeparatorIndex(raw);
    head = (sep >= Math.floor(headLen / 3) ? raw.slice(0, sep) : raw).trimEnd()
      || raw.slice(0, Math.max(1, headLen));
  }

  const tailBudget = maxLength - ellipsis.length - head.length;
  if (tailBudget <= 0) {
    return `${head.slice(0, budget)}${ellipsis}`;
  }
  let tail = label.slice(-tailBudget);
  const leadSep = tail.search(/[\s,.—–-]/u);
  if (leadSep >= 0 && leadSep < tail.length - 1) {
    tail = tail.slice(leadSep + 1).trimStart() || tail.trimStart();
  } else {
    tail = tail.trimStart();
  }
  if (tail.length === 0) {
    return `${label.slice(0, budget)}${ellipsis}`;
  }

  while (
    head.length + ellipsis.length + tail.length > maxLength
    && (head.length > 1 || tail.length > 1)
  ) {
    if (lockHead && tail.length > 1) {
      tail = tail.slice(1).trimStart();
    } else if (head.length > 1) {
      head = head.slice(0, -1).trimEnd();
    } else {
      tail = tail.slice(1).trimStart();
    }
  }
  const result = `${head}${ellipsis}${tail}`;
  return result.length <= maxLength ? result : result.slice(0, maxLength);
};

const ensureUniqueChipLabels = (
  labels: readonly string[],
  maxLength: number = MAX_FAQ_CHIP_LABEL_LENGTH,
): string[] => {
  const used = new Set<string>();
  return labels.map((raw) => {
    const trimmed = raw.trim();
    let n = 0;
    let candidate = "";
    do {
      const suffix = n === 0 ? "" : ` (${n + 1})`;
      const room = Math.max(1, maxLength - suffix.length);
      candidate = `${truncateLabel(trimmed, room)}${suffix}`;
      n += 1;
    } while (used.has(normalizeReplyLabel(candidate)));
    used.add(normalizeReplyLabel(candidate));
    return candidate;
  });
};

/** Full text for message bullets; chip label when displayLabel is absent. */
export const faqChoiceTextLabel = (choice: InteractionChoice): string =>
  (choice.displayLabel ?? choice.label).trim();

const shouldStripSharedPrefix = (
  sharedPrefix: string,
  selectedLabel: string | undefined,
): boolean => {
  if (sharedPrefix.length === 0) {
    return false;
  }
  const selected = normalizeReplyLabel(selectedLabel ?? "");
  if (selected.length === 0) {
    return false;
  }
  return normalizeReplyLabel(sharedPrefix).includes(selected);
};

export type ShortenFaqChoiceLabelsOptions = {
  selectedLabel?: string;
};

export const shortenFaqChoiceLabels = (
  choices: readonly InteractionChoice[],
  options?: ShortenFaqChoiceLabelsOptions,
): InteractionChoice[] => {
  if (choices.length === 0) {
    return [];
  }
  if (choices.length === 1) {
    const choice = choices[0]!;
    const text = faqChoiceTextLabel(choice);
    const chip = truncateLabel(text, MAX_FAQ_CHIP_LABEL_LENGTH);
    return [{
      id: choice.id,
      label: chip,
      ...(chip !== text ? { displayLabel: text } : {}),
      ...(choice.serviceIds != null ? { serviceIds: choice.serviceIds } : {}),
    }];
  }
  const names = choices.map(faqChoiceTextLabel);
  const sharedPrefix = sharedPathPrefix(names);
  const stripPrefix = shouldStripSharedPrefix(sharedPrefix, options?.selectedLabel)
    ? sharedPrefix
    : "";
  const textLabels = names.map((name) => shortFaqTextLabel(name, stripPrefix));
  const shortened = textLabels.map((label) => truncateLabel(label, MAX_FAQ_CHIP_LABEL_LENGTH));
  // If aesthetic truncation collapses distinct CRM rows (e.g. Botox/Nabota
  // with a shared long prefix and suffix), show their canonical names instead
  // of presenting a misleading `(2)` identity. Only truly identical names need
  // numeric disambiguation.
  const shortenedUnique = new Set(shortened.map(normalizeReplyLabel)).size === shortened.length;
  const chipLabels = shortenedUnique
    ? ensureUniqueChipLabels(textLabels)
    : ensureUniqueChipLabels(names, Math.max(...names.map((name) => name.length)));
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

export const buildFaqCatalogChoices = (
  services: readonly CatalogPageRow[],
  remainingIds?: readonly string[],
): InteractionChoice[] => {
  const rows = remainingIds != null && remainingIds.length > 0
    ? services.filter((row) => remainingIds.includes(row.id))
    : services;
  return rows.map((row) => ({
    id: row.id,
    label: row.name.trim(),
    serviceIds: [row.id],
  }));
};

export const mergeCatalogChoicesToPageCap = (
  choices: readonly InteractionChoice[],
): InteractionChoice[] => {
  if (choices.length <= MAX_FAQ_CATALOG_CHOICES) {
    return choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      serviceIds: choice.serviceIds != null ? [...choice.serviceIds] : [choice.id],
      ...(choice.displayLabel != null ? { displayLabel: choice.displayLabel } : {}),
      ...(choice.aliases != null ? { aliases: [...choice.aliases] } : {}),
    }));
  }
  const head = choices.slice(0, MAX_FAQ_CATALOG_CHOICES - 1);
  const tail = choices.slice(MAX_FAQ_CATALOG_CHOICES - 1);
  const overflowIds = tail.flatMap((choice) =>
    choice.serviceIds != null && choice.serviceIds.length > 0
      ? [...choice.serviceIds]
      : [choice.id]
  );
  const otherInHead = head.findIndex(
    (choice) => choice.label.trim() === SERVICE_CANDIDATE_OTHER_LABEL_UK,
  );
  if (otherInHead >= 0) {
    const existing = head[otherInHead]!;
    const mergedIds = [
      ...(existing.serviceIds != null && existing.serviceIds.length > 0
        ? existing.serviceIds
        : [existing.id]),
      ...overflowIds,
    ];
    return head.map((choice, index) =>
      index === otherInHead
        ? {
          ...choice,
          id: choice.id,
          label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
          serviceIds: [...new Set(mergedIds)],
        }
        : {
          id: choice.id,
          label: choice.label,
          serviceIds: choice.serviceIds != null ? [...choice.serviceIds] : [choice.id],
          ...(choice.displayLabel != null ? { displayLabel: choice.displayLabel } : {}),
          ...(choice.aliases != null ? { aliases: [...choice.aliases] } : {}),
        }
    );
  }
  return [
    ...head.map((choice) => ({
      id: choice.id,
      label: choice.label,
      serviceIds: choice.serviceIds != null ? [...choice.serviceIds] : [choice.id],
      ...(choice.displayLabel != null ? { displayLabel: choice.displayLabel } : {}),
      ...(choice.aliases != null ? { aliases: [...choice.aliases] } : {}),
    })),
    {
      id: "faq_other",
      label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
      serviceIds: [...new Set(overflowIds)],
    },
  ];
};

const isCrmSingletonChoice = (choice: InteractionChoice): boolean =>
  choice.serviceIds != null
  && choice.serviceIds.length === 1
  && choice.serviceIds[0] === choice.id;

const uniquifyCatalogChoiceIds = (
  choices: readonly InteractionChoice[],
): InteractionChoice[] => {
  const reserved = new Set(
    choices.filter(isCrmSingletonChoice).map((choice) => choice.id),
  );
  const used = new Set<string>();
  let nextG = 0;
  const allocGroupId = (): string => {
    while (used.has(`g${nextG}`) || reserved.has(`g${nextG}`)) {
      nextG += 1;
    }
    const id = `g${nextG}`;
    nextG += 1;
    used.add(id);
    return id;
  };
  return choices.map((choice) => {
    if (isCrmSingletonChoice(choice)) {
      if (!used.has(choice.id)) {
        used.add(choice.id);
        return { ...choice, id: choice.id };
      }
      return { ...choice, id: allocGroupId() };
    }
    if (!used.has(choice.id) && !reserved.has(choice.id)) {
      used.add(choice.id);
      return { ...choice };
    }
    return { ...choice, id: allocGroupId() };
  });
};

export const fallbackCatalogPageChoices = (
  services: readonly CatalogPageRow[],
  remainingIds?: readonly string[],
): InteractionChoice[] =>
  shortenFaqChoiceLabels(
    uniquifyCatalogChoiceIds(
      mergeCatalogChoicesToPageCap(buildFaqCatalogChoices(services, remainingIds)),
    ),
  );

/** Map interaction choices from a catalog page to booking-domain chips. */
export const catalogChipsFromInteractionChoices = (
  choices: readonly InteractionChoice[],
): Array<{
  id: string;
  label: string;
  serviceIds: string[];
  displayLabel?: string;
}> =>
  choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    serviceIds: choice.serviceIds != null && choice.serviceIds.length > 0
      ? [...choice.serviceIds]
      : [choice.id],
    ...(choice.displayLabel != null ? { displayLabel: choice.displayLabel } : {}),
  }));

export const finalizeCatalogPageChoices = (
  raw: readonly InteractionChoice[],
  options?: ShortenFaqChoiceLabelsOptions,
): InteractionChoice[] =>
  shortenFaqChoiceLabels(
    uniquifyCatalogChoiceIds(mergeCatalogChoicesToPageCap(raw)),
    options?.selectedLabel != null && options.selectedLabel.length > 0
      ? { selectedLabel: options.selectedLabel }
      : undefined,
  );
