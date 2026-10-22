import type { InteractionChoice } from "./booking-session.js";
import type { ServicesContext } from "../tools/service-tools.js";
import {
  interactionChoicesFromSelectorGroups,
  partitionRemainingServiceChoices,
  type PartitionServiceCandidates,
} from "./service-resolution.js";
import {
  buildFaqCatalogChoices,
  faqChoiceTextLabel,
  finalizeCatalogPageChoices,
} from "./catalog-page-choices.js";

export {
  buildFaqCatalogChoices,
  fallbackCatalogPageChoices,
  faqChoiceTextLabel,
  mergeCatalogChoicesToPageCap,
  shortenFaqChoiceLabels,
  type ShortenFaqChoiceLabelsOptions,
} from "./catalog-page-choices.js";

const FAQ_CATALOG_CLOSE_UK = "Який варіант вам підходить?";
const FAQ_CATALOG_EMPTY_UK = "Оберіть, будь ласка, послугу зі списку.";
const FAQ_CATALOG_INTRO_FALLBACK_UK = "Доступні такі варіанти:";

const FAQ_LIST_LINE = /^\s*(?:[•*\-]|\d+[.)])\s/m;

const AFTER_QUESTION_DECORATION =
  /^[\s*_`~"'»«)\]}.…\uFE0F\uFE0E\p{Extended_Pictographic}\u200D]*$/u;

const stripTrailingQuestionSentence = (text: string): string => {
  const trimmed = text.trim();
  const q = trimmed.lastIndexOf("?");
  if (q < 0) {
    return trimmed;
  }
  if (!AFTER_QUESTION_DECORATION.test(trimmed.slice(q + 1))) {
    return trimmed;
  }
  const before = trimmed.slice(0, q);
  const boundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("\n"),
  );
  if (boundary < 0) {
    return "";
  }
  return trimmed
    .slice(0, boundary + (trimmed[boundary] === "\n" ? 0 : 1))
    .trim();
};

export const faqCatalogIntroFromModel = (text: string): string => {
  const beforeList = text.split(FAQ_LIST_LINE)[0] ?? "";
  const paragraphs = beforeList
    .split(/\n{2,}/)
    .map((part) => stripTrailingQuestionSentence(part))
    .filter((part) => part.length > 0);
  return paragraphs.slice(0, 2).join("\n\n").trim();
};

export const faqCatalogPreserveModelAnswer = (text: string): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = paragraphs.at(-1) ?? "";
  const lastIsChoiceQuestion =
    last.includes("?")
    && stripTrailingQuestionSentence(last).length === 0;
  if (lastIsChoiceQuestion) {
    return null;
  }
  if (faqCatalogIntroFromModel(trimmed).length === 0) {
    return null;
  }
  return trimmed;
};

export const catalogChoiceBulletBlock = (
  choices: readonly InteractionChoice[],
  services: ServicesContext["list"] = [],
): string => {
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
    return "";
  }
  return `${lines.join("\n")}\n\n${FAQ_CATALOG_CLOSE_UK}`;
};

export const renderFaqCatalogReply = (
  choices: readonly InteractionChoice[],
  services: ServicesContext["list"] = [],
  modelIntro: string = "",
): string => {
  const block = catalogChoiceBulletBlock(choices, services);
  if (block.length === 0) {
    return FAQ_CATALOG_EMPTY_UK;
  }
  const intro = modelIntro.trim().length > 0
    ? modelIntro.trim()
    : FAQ_CATALOG_INTRO_FALLBACK_UK;
  return `${intro}\n\n${block}`;
};

export const resolveFaqCatalogChoices = async (input: {
  services: ServicesContext["list"];
  remainingIds?: readonly string[];
  utterance: string;
  query?: string;
  selectedLabel?: string;
  groups?: Array<{ label: string; serviceIds: string[] }>;
  partitionCandidates?: PartitionServiceCandidates;
}): Promise<InteractionChoice[]> => {
  const fromSelectorGroups = input.remainingIds != null && input.groups != null
    ? interactionChoicesFromSelectorGroups(
      input.services,
      input.remainingIds,
      input.groups,
    )
    : [];
  let raw: InteractionChoice[];
  if (fromSelectorGroups.length > 0) {
    raw = fromSelectorGroups;
  } else {
    const partitioned = await partitionRemainingServiceChoices({
      rows: input.services,
      ...(input.remainingIds != null ? { remainingIds: input.remainingIds } : {}),
      utterance: input.utterance,
      ...(input.query != null ? { query: input.query } : {}),
      ...(input.partitionCandidates != null
        ? { partitionCandidates: input.partitionCandidates }
        : {}),
    });
    raw = partitioned.length > 0
      ? partitioned
      : buildFaqCatalogChoices(input.services, input.remainingIds);
  }
  return finalizeCatalogPageChoices(
    raw,
    input.selectedLabel != null && input.selectedLabel.length > 0
      ? { selectedLabel: input.selectedLabel }
      : undefined,
  );
};
