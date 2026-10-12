/**
 * Helpers for Langfuse metadata coercion.
 * No Langfuse / OpenTelemetry imports — safe for unit tests without SDK boot.
 * Span masking and Tier 1 prop allowlisting are intentionally off for debugging.
 */

/** Coerce metadata values to strings ≤200 chars for propagateAttributes. */
export const toPropagateMetadata = (
  metadata: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    const str = typeof value === "string" ? value : String(value);
    out[key] = str.length > 200 ? str.slice(0, 200) : str;
  }
  return out;
};
