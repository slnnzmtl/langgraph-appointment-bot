import { SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES } from "../shared/clinic-constants.js";
import {
  isSupervisorOwnedLabel,
  labelIdFor,
  matchesReplyLabel,
  normalizeReplyLabel,
} from "../shared/message-content.js";
import type { ServicesContext } from "../tools/service-tools.js";
import { isFaqServicesGuideLabel } from "../shared/message-content.js";
import {
  safeSelect,
  type SelectServiceCandidates,
} from "./service-resolution.js";

/** Min length so tiny taps like «1» do not steal an offer keyboard or resume. */
const FAQ_CATALOG_NAME_MIN_LEN = 3;
/** Stem tokens shorter than this are too ambiguous for prefix matching. */
const FAQ_CATALOG_STEM_MIN_LEN = 5;

/** Collapse doubled letters so «коллаген» aligns with «колаген…». */
const collapseDoubledLetters = (token: string): string =>
  token.replace(/(.)\1+/gu, "$1");

const catalogNameTokens = (name: string): string[] =>
  name.split(/[\s,/()]+/u).filter((token) => token.length > 0);

/** Shared prefix length — handles UA case endings («…цію» vs «…ція»). */
const sharedPrefixLength = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
};

const utteranceMatchesCatalogName = (
  normalizedUtterance: string,
  name: string,
): boolean => {
  if (
    normalizedUtterance === name
    || name.includes(normalizedUtterance)
    || normalizedUtterance.includes(name)
  ) {
    return true;
  }
  const utteranceTokens = catalogNameTokens(normalizedUtterance)
    .map(collapseDoubledLetters)
    .filter((token) => token.length >= FAQ_CATALOG_STEM_MIN_LEN);
  if (utteranceTokens.length === 0) {
    return false;
  }
  const nameTokens = catalogNameTokens(name).map(collapseDoubledLetters);
  return utteranceTokens.some((token) =>
    nameTokens.some(
      (nameToken) =>
        sharedPrefixLength(token, nameToken) >= FAQ_CATALOG_STEM_MIN_LEN,
    ));
};

/**
 * CRM rows whose names match free-text (brand/family/full title). Used by
 * resolveCatalogFreeText for model `open_catalog` query / tag matching.
 */
export const matchingCatalogRows = (
  text: string,
  services: ServicesContext["list"],
): ServicesContext["list"] => {
  const normalized = normalizeReplyLabel(text);
  if (
    normalized.length < FAQ_CATALOG_NAME_MIN_LEN
    || normalized.includes("?")
  ) {
    return [];
  }
  return services.filter((row) => {
    const name = normalizeReplyLabel(row.name);
    return utteranceMatchesCatalogName(normalized, name);
  });
};

/**
 * Strip optional trailing `?` and collect CRM lexical hits.
 * Does not reject keyboard / supervisor / choose_other / FAQ-guide labels —
 * those guards stay on {@link resolveCatalogFreeText}.
 */
export const resolveCatalogLexicalEvidence = (
  text: string,
  services: ServicesContext["list"],
  options?: { allowTerminalQuestion?: boolean },
): {
  matcher: string;
  rows: ServicesContext["list"];
} => {
  const trimmed = text.trim();
  const matcher =
    options?.allowTerminalQuestion === true
      ? trimmed.replace(/[?？]+\s*$/u, "").trim()
      : trimmed;
  return {
    matcher,
    rows: matchingCatalogRows(matcher, services),
  };
};

export type CatalogFreeTextResult =
  | { kind: "none" }
  | { kind: "one"; row: ServicesContext["list"][number] }
  | {
    kind: "many";
    ids: string[];
    groups?: Array<{ label: string; serviceIds: string[] }>;
  };

/**
 * Whole-family selector override: include every brand/zone in the procedure
 * family and return one guide level — not only titles that contain the word.
 */
export const CATALOG_FAMILY_SELECTOR_QUERY =
  "Include every CRM row in that procedure family (all brands and zones), "
  + "including titles that do not contain the patient's word. "
  + "Group exactly one guide level (brand or zone), the same level as tapping that family.";

/**
 * Free-text catalog resolution (DDD-266 order):
 * 1. Structured CRM id / chip — handled in FAQ prepare before this helper.
 * 2. Exact CRM title (`normalizeReplyLabel` equality on lexical row).
 * 3. One `selectCandidates` pass after lexical stems gate slang/families.
 * 4. Consultation / clarification — booking-session + FAQ LLM when this returns `none`.
 *
 * Partitioning (`partitionCandidates`) runs only after step 3 yields many ids
 * (chip rendering), not as a parallel classifier.
 *
 * `allowTerminalQuestion`: named_procedure only — strip trailing `?`/`？` into a
 * local matcher string so rematch / model `open_catalog` keep rejecting `?`.
 */
export const resolveCatalogFreeText = async (input: {
  text: string;
  rows: ServicesContext["list"];
  selectCandidates?: SelectServiceCandidates;
  allowTerminalQuestion?: boolean;
}): Promise<CatalogFreeTextResult> => {
  const { matcher, rows: lexical } = resolveCatalogLexicalEvidence(
    input.text,
    input.rows,
    input.allowTerminalQuestion === true
      ? { allowTerminalQuestion: true }
      : undefined,
  );
  if (
    matcher.length === 0
    || matcher.includes("?")
    || labelIdFor(matcher) != null
    || isSupervisorOwnedLabel(matcher)
    || matchesReplyLabel(matcher, SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES)
    || isFaqServicesGuideLabel(matcher)
  ) {
    return { kind: "none" };
  }
  const normalized = normalizeReplyLabel(matcher);
  if (normalized.length < FAQ_CATALOG_NAME_MIN_LEN) {
    return { kind: "none" };
  }
  if (input.rows.length === 0) {
    return { kind: "none" };
  }

  // CRM stem evidence gates the family selector. Compare / price lines with no
  // procedure stems must not call the selector on the full catalog (it invents
  // a family). «ботокс» stems to a subset; the selector still sees all rows so
  // it can expand to brand/zone siblings that do not share the patient token.
  if (lexical.length === 0) {
    return { kind: "none" };
  }
  if (lexical.length === 1) {
    const row = lexical[0]!;
    // Exact CRM title only — substring/stem hits fall through to the family selector.
    if (normalizeReplyLabel(row.name) === normalized) {
      return { kind: "one", row };
    }
  }

  const allowlist = new Map(input.rows.map((row) => [row.id, row]));
  if (input.selectCandidates != null) {
    // Matcher line (trailing ? already stripped when named_procedure opts in).
    const selection = await safeSelect(input.selectCandidates, {
      utterance: matcher,
      query: CATALOG_FAMILY_SELECTOR_QUERY,
      candidates: input.rows.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.description != null ? { description: row.description } : {}),
      })),
    });
    const ids = [...new Set(
      (selection?.serviceIds ?? []).filter((id) => allowlist.has(id)),
    )];
    if (ids.length === 1) {
      return { kind: "one", row: allowlist.get(ids[0]!)! };
    }
    if (ids.length > 1) {
      return {
        kind: "many",
        ids,
        ...(selection?.groups != null ? { groups: selection.groups } : {}),
      };
    }
  }

  // One lexical hit → offer that CRM row; several hits need the selector above.
  if (lexical.length === 1) {
    return { kind: "one", row: lexical[0]! };
  }
  return { kind: "none" };
};
