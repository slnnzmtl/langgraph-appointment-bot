/**
 * Lexical detector for patient-facing booking outcome claims.
 * Used only as telemetry (false_success_claim) — never to rewrite a reply.
 * Clinic address is intentionally not a signal (patients may ask for it anytime).
 *
 * Note: JS `\b` is ASCII-only, so Cyrillic stems use lookaround on letter edges.
 */

const NEGATION_BEFORE =
  /(?:не\s+(?:було\s+)?|нічого\s+не\s+|nothing\s+(?:was\s+)?|was\s+not\s+|weren'?t\s+)\s*$/iu;

const EDGE = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";

/** Success / outcome stems (Ukrainian, Russian, English). */
const OUTCOME_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "gotovo", re: new RegExp(`${EDGE}готово${END}`, "iu") },
  { rule: "stvoreno", re: new RegExp(`${EDGE}створен[оаи]${END}`, "iu") },
  { rule: "pereneseno", re: new RegExp(`${EDGE}перенесен[оаи]${END}`, "iu") },
  { rule: "skasovano", re: new RegExp(`${EDGE}скасован[оаи]${END}`, "iu") },
  { rule: "zabronyovano", re: new RegExp(`${EDGE}заброн(?:ьован|ирован)[оаи]${END}`, "iu") },
  {
    rule: "pidtverdzheno",
    re: new RegExp(`${EDGE}(?:підтверджен|подтвержден)[оаи]${END}`, "iu"),
  },
  { rule: "zapysano", re: new RegExp(`${EDGE}записан[оаиійя]${END}`, "iu") },
  { rule: "booked", re: /\bbooked\b/i },
  { rule: "rescheduled", re: /\brescheduled\b/i },
  { rule: "cancelled", re: /\bcancell?ed\b/i },
  { rule: "confirmed", re: /\bconfirmed\b/i },
];

export type OutcomeClaimMatch = {
  rule: string;
};

/** True when text claims a booking outcome and is not clearly negated. */
export const claimsOutcome = (text: string): OutcomeClaimMatch | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  for (const { rule, re } of OUTCOME_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(trimmed);
    if (match == null || match.index == null) {
      continue;
    }
    const before = trimmed.slice(0, match.index);
    if (NEGATION_BEFORE.test(before)) {
      continue;
    }
    return { rule };
  }
  return null;
};
